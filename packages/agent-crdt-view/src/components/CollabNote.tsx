import { AvButton, AvTextArea } from "@claude-bot/agent-view-react/ui";
/**
 * The collaborative document surface: a rendered page, an edit mode with a
 * Markdown toolbar, and an honest status line.
 *
 * ── The 2026-08-10 product decision ────────────────────────────────────────
 *
 * This component began as an architecture probe (a bare textarea + Sync
 * button) whose CLAUDE.md said "no rich editor". The product owner overruled
 * the scope half of that: the document surface is now a real reading and
 * writing experience aligned with what people expect from a cloud document.
 * The PLATFORM half is untouched and still enforced by `architecture.test.ts`
 * — no Yjs provider, no second channel, no polling — so the alignment is
 * built the way the constraints allow:
 *
 *  · the CRDT keeps holding MARKDOWN SOURCE in one `Y.Text` (concurrent edits
 *    keep merging at character level, exactly as before);
 *  · reading is the default: an opened document renders through the SDK's
 *    sanitising `Markdown` primitive, typographically, like a page;
 *  · 编辑 flips the same panel to the source in a textarea, with a toolbar of
 *    pure text transforms (`lib/markdown-edit.ts`) — not a contenteditable
 *    tree editor, which would drag TipTap/ProseMirror plus a `Y.XmlFragment`
 *    migration into an untrusted bundle for a first release nobody asked to
 *    review at that size.
 *
 * ── Refusals are rendered, never thrown ────────────────────────────────────
 *
 * `approval_required` and `rate_limited` are instructions, not faults. An
 * error boundary would replace both with "something went wrong", and a person
 * told that will reload — which on this platform can cost another approval
 * card.
 */

import { useEffect, useRef, useState } from "react";
import { Banner, EmptyState, Markdown, StatusChip } from "@claude-bot/agent-view-react/ui";
import type { NoteState } from "../lib/session.js";
import { applyMarkdownCommand, type MarkdownCommand } from "../lib/markdown-edit.js";

export interface CollabNoteProps {
  /** Null when this panel is standing and nothing has been opened into it. */
  hasDocument: boolean;
  label: string;
  state: NoteState;
  onChange(text: string): void;
  onSync(): void;
  onClose?(): void;
  domIdScope?: string;
}

/** Codes a person can act on get a sentence of their own. */
const ACTIONABLE: Readonly<Record<string, string>> = Object.freeze({
  approval_required: "需要文档主人在待批准列表里确认，批准后点一次「同步」。",
  no_authority: "当前登录没有这份协作文档的相应授权。",
  rate_limited: "改动推送得太快了，稍等一下再点同步。本地内容没有丢。",
  doc_too_large: "这份文档已经超过一次读取能承载的大小。",
  bad_update: "这次改动没有被接受。请复制一份本地内容后重新打开。",
  unknown_doc: "这个文档引用已经失效，请重新打开。",
  scope_closed: "这个视图的会话已经结束，请重新打开页面。",
});

/** The toolbar, as data: label, command, and the title a person hovers. */
const TOOLBAR: ReadonlyArray<readonly [string, MarkdownCommand, string] | null> = Object.freeze([
  ["B", "bold", "加粗"],
  ["I", "italic", "斜体"],
  ["S̶", "strike", "删除线"],
  ["‹›", "code", "行内代码"],
  null,
  ["H1", "h1", "一级标题"],
  ["H2", "h2", "二级标题"],
  ["H3", "h3", "三级标题"],
  null,
  ["•", "ul", "无序列表"],
  ["1.", "ol", "有序列表"],
  ["❝", "quote", "引用"],
  ["```", "codeblock", "代码块"],
  ["—", "hr", "分割线"],
]);

export function CollabNote(props: CollabNoteProps) {
  const id = (name: string): string => (props.domIdScope ? `${name}-${props.domIdScope}` : name);
  // Reading is the default; 编辑 is a deliberate gesture. Per-mount state:
  // opening another document into this panel starts back at the page view.
  const [editing, setEditing] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  // A toolbar command changes text AND selection; the selection half can only
  // land after React commits the value, hence the two-step through state.
  const [pendingSelection, setPendingSelection] = useState<{ start: number; end: number } | null>(null);
  useEffect(() => {
    if (!pendingSelection) return;
    const area = bodyRef.current;
    if (area) {
      area.focus();
      area.setSelectionRange(pendingSelection.start, pendingSelection.end);
    }
    setPendingSelection(null);
  }, [pendingSelection]);

  if (!props.hasDocument) {
    return (
      <EmptyState
        icon="📄"
        title="选择一份文档"
        text="在左侧「文档」列表里点击一篇，就会在这里打开。"
      />
    );
  }

  const { state } = props;
  const editable = state.status === "ready" && !state.incompatible;

  const runCommand = (command: MarkdownCommand): void => {
    const area = bodyRef.current;
    if (!area || !editable) return;
    const next = applyMarkdownCommand(
      { text: area.value, start: area.selectionStart, end: area.selectionEnd },
      command,
    );
    props.onChange(next.text);
    setPendingSelection({ start: next.start, end: next.end });
  };

  return (
    <section className="crdtdoc" id={id("crdtdoc")}>
      <header className="crdtdoc-bar">
        <h1 className="crdtdoc-title">{props.label || "协作文档"}</h1>
        <span className="crdtdoc-status">
          {state.syncing ? (
            <StatusChip busy word="正在同步最新内容" tone="info" />
          ) : state.remoteHint ? (
            <StatusChip icon="●" word="有新改动，点同步查看" tone="warn" />
          ) : state.unsent ? (
            <StatusChip icon="●" word="有未同步的改动" tone="warn" />
          ) : state.status === "ready" ? (
            <StatusChip icon="✓" word="已同步" tone="ok" />
          ) : null}
        </span>
        <span className="crdtdoc-actions">
          {editable ? (
            <AvButton
              id={id("crdtdoc-mode")}
              className={editing ? "crdtdoc-mode is-editing" : "crdtdoc-mode"}
              onClick={() => setEditing((mode) => !mode)}
            >
              {editing ? "预览" : "编辑"}
            </AvButton>
          ) : null}
          <AvButton
            id={id("crdtdoc-sync")}
            onClick={props.onSync}
            disabled={state.status !== "ready" || state.syncing}
          >
            同步
          </AvButton>
          {props.onClose ? (
            <AvButton onClick={props.onClose}>
              关闭
            </AvButton>
          ) : null}
        </span>
      </header>

      {state.incompatible ? (
        <Banner
          icon="⚠"
          tone="warn"
          title="只读"
          text="这份文档的结构版本比本视图更新，因此只显示不编辑，以免写入本视图无法理解的内容。"
        />
      ) : null}

      {state.code ? (
        <Banner
          icon="⚠"
          tone={state.code === "rate_limited" || state.code === "approval_required" ? "warn" : "error"}
          title={ACTIONABLE[state.code] ?? "这次请求没有完成。"}
          text={state.message}
        />
      ) : null}

      {/* "idle" is the render between a panel getting a resource and its effect
          committing the session. Painting an empty page there would be a flash
          of an empty document over somebody's writing. */}
      {state.status === "opening" || state.status === "idle" ? (
        <p className="crdtdoc-hint">正在打开…</p>
      ) : editing && editable ? (
        <div className="crdtdoc-editwrap">
          <div className="crdtdoc-toolbar" role="toolbar" aria-label="格式">
            {TOOLBAR.map((entry, index) =>
              entry ? (
                <AvButton
                  key={entry[1]}
                  className="crdtdoc-tool"
                  title={entry[2]}
                  aria-label={entry[2]}
                  // The textarea's selection must survive the click, or every
                  // command would apply to a collapsed caret at the end.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => runCommand(entry[1])}
                >
                  {entry[0]}
                </AvButton>
              ) : (
                <span key={`gap-${index}`} className="crdtdoc-toolgap" aria-hidden />
              ),
            )}
          </div>
          <AvTextArea
            ref={bodyRef}
            className="crdtdoc-source"
            id={id("crdtnote-body")}
            aria-label={props.label || "协作文档"}
            value={state.text}
            spellCheck={false}
            onChange={(event) => props.onChange(event.target.value)}
          />
        </div>
      ) : (
        <div className="crdtdoc-page" id={id("crdtdoc-page")}>
          {state.text.trim() === "" ? (
            <p className="crdtdoc-hint">这篇文档还是空的。点右上角「编辑」开始写。</p>
          ) : (
            <Markdown className="crdtdoc-prose">{state.text}</Markdown>
          )}
        </div>
      )}

      <footer className="crdtdoc-foot">
        {/* Said plainly, because it is the platform's actual behaviour. */}
        改动自动推送；别人有改动时会自动合并或提醒你同步。
        {state.syncedAt ? ` 上次同步 ${timeOf(state.syncedAt)}。` : ""}
      </footer>
    </section>
  );
}

function timeOf(at: number): string {
  const date = new Date(at);
  const two = (n: number): string => String(n).padStart(2, "0");
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}
