import { AvButton, AvInput } from "@claude-bot/agent-view-react/ui";
/**
 * The visual editing surface: a toolbar, a 16:9 stage, and one slide on it.
 *
 * ── Why there is no save button ─────────────────────────────────────────────
 *
 * The form editor this replaced batched a whole slide into N proposals behind
 * an explicit save, and the worklog records what that cost (walls 4 and 5).
 * On this canvas a gesture IS a command: commit-on-blur here is not "N
 * proposals fired by a focus change" — it is ONE proposal naming the one
 * region the person just left, so the partial-save arithmetic never starts.
 * The module owns the sending; this component only reports gestures.
 *
 * ── What stays a form ───────────────────────────────────────────────────────
 *
 * `image.ref` and `image.alt` are not printed on the slide (the ref is a
 * token, the alt is for a reader who cannot see the image), so there is
 * nothing on the canvas to click INTO. They keep a small property strip under
 * the stage — same commit-on-blur contract, plus the contract's own ref check
 * BEFORE proposing, because an editor that proposes a ref the reader refuses
 * has advertised an edit that can never land.
 *
 * ── The toolbar is the deck's, not the slide's ──────────────────────────────
 *
 * Layout insertion and the theme live there because they are properties of
 * the DOCUMENT a person edits while looking at a slide — the same reason a
 * slides product puts them in its top chrome. The theme toggle proposes
 * `set_theme`, a wire command like any other; nothing here writes state.
 */

import { useState } from "react";
import { Banner } from "@claude-bot/agent-view-react/ui";
import {
  DECK_LAYOUTS,
  DECK_LIMITS,
  deckRefProblem,
  type DeckLayout,
  type DeckSlide,
  type DeckTheme,
} from "@claude-bot/deck-model-contract";
import { LAYOUT_LABELS, UNTITLED, fieldLabel } from "../lib/labels.js";
import { InlineText, NewItemText } from "./InlineText.js";
import { SlideSurface, regionName, type SurfaceRegion } from "./SlideSurface.js";
import { listValue } from "../lib/edits.js";

export interface CanvasNotice {
  tone: "ok" | "warn" | "error" | "info";
  text: string;
}

export interface SlideCanvasProps {
  title: string;
  slide: DeckSlide;
  theme: DeckTheme;
  /** Zero-based position of the slide, and how many there are. */
  index: number;
  count: number;
  /** False when the instance has no `command_action`: the same stage, inert. */
  editable: boolean;
  /** Commands in flight. Shown, never used to lock the canvas. */
  pending: number;
  notice: CanvasNotice | null;
  hint: string;
  onText(field: string, index: number | null, next: string, seed: string): void;
  onAddItem(field: string, value: string): void;
  onRemoveItem(field: string, index: number): void;
  onMoveItem(field: string, index: number, delta: -1 | 1): void;
  onInsertSlide(layout: DeckLayout): void;
  onTheme(theme: DeckTheme): void;
  onClose?(): void;
}

const ITEM_LABELS: Readonly<Record<string, string>> = Object.freeze({
  bullets: "要点",
  left: "左栏",
  right: "右栏",
});

export function SlideCanvas({
  title,
  slide,
  theme,
  index,
  count,
  editable,
  pending,
  notice,
  hint,
  onText,
  onAddItem,
  onRemoveItem,
  onMoveItem,
  onInsertSlide,
  onTheme,
  onClose,
}: SlideCanvasProps) {
  const itemLabel = (field: string, at: number): string => `${ITEM_LABELS[field] ?? field} 第 ${at + 1} 条`;

  const text = (region: SurfaceRegion, value: string, placeholder: string, className: string) => (
    <InlineText
      value={value}
      placeholder={placeholder}
      className={className}
      label={region.index === undefined ? fieldLabel(region.field) : itemLabel(region.field, region.index)}
      region={regionName(region)}
      disabled={!editable}
      onCommit={(next, seed) => onText(region.field, region.index ?? null, next, seed)}
    />
  );

  const itemChrome = (field: string, at: number) => {
    if (!editable) return null;
    const items = listValue(slide, field);
    return (
      <span className="dkv-sur-itemops">
        <AvButton
          aria-label={`上移 ${itemLabel(field, at)}`}
          data-dkv-item-up={`${field}:${at}`}
          disabled={at === 0}
          onClick={() => onMoveItem(field, at, -1)}
        >
          ↑
        </AvButton>
        <AvButton
          aria-label={`下移 ${itemLabel(field, at)}`}
          data-dkv-item-down={`${field}:${at}`}
          disabled={at === items.length - 1}
          onClick={() => onMoveItem(field, at, 1)}
        >
          ↓
        </AvButton>
        <AvButton
          aria-label={`删除 ${itemLabel(field, at)}`}
          data-dkv-item-remove={`${field}:${at}`}
          onClick={() => onRemoveItem(field, at)}
        >
          ✕
        </AvButton>
      </span>
    );
  };

  const listFoot = (field: string) =>
    editable ? (
      <NewItemText
        label={`添加${ITEM_LABELS[field] ?? field}`}
        field={field}
        full={listValue(slide, field).length >= DECK_LIMITS.maxListItems}
        onCommit={(value) => onAddItem(field, value)}
      />
    ) : null;

  return (
    <section className="dkv-editor" data-dkv-slide={slide.id} data-dkv-layout={slide.layout}>
      <header className="dkv-toolbar" role="toolbar" aria-label={title || "幻灯画布"}>
        <b className="dkv-tb-name">{title || "幻灯画布"}</b>
        {editable ? (
          <>
            <span className="dkv-tb-group" aria-label="添加一页">
              {DECK_LAYOUTS.map((layout) => (
                <AvButton key={layout} data-dkv-insert={layout} onClick={() => onInsertSlide(layout)}>
                  ＋{LAYOUT_LABELS[layout]}
                </AvButton>
              ))}
            </span>
            <AvButton
              className="dkv-tb-theme"
              data-dkv-theme-toggle
              aria-pressed={theme === "dark"}
              onClick={() => onTheme(theme === "dark" ? "light" : "dark")}
            >
              {theme === "dark" ? "深色主题" : "浅色主题"}
            </AvButton>
          </>
        ) : (
          <span className="dkv-readonly">只读</span>
        )}
        <span className="dkv-tb-page" data-dkv-page>
          第 {index + 1} / {count} 页
        </span>
        {pending > 0 ? (
          <span className="dkv-tb-sync" role="status">
            同步中…
          </span>
        ) : null}
        {onClose ? (
          <AvButton className="dkv-close" data-dkv-close onClick={onClose}>
            关闭
          </AvButton>
        ) : null}
      </header>

      <div className="dkv-stage">
        <div className="dkv-canvas" data-dkv-canvas aria-label={`第 ${index + 1} 页：${slide.title || UNTITLED}`}>
          <SlideSurface slide={slide} theme={theme} text={text} itemChrome={itemChrome} listFoot={listFoot} />
        </div>
      </div>

      {notice ? <Banner tone={notice.tone} title={notice.text} /> : null}

      {slide.layout === "image-ref" ? (
        <div className="dkv-props" data-dkv-props>
          <RefField
            label={fieldLabel("image.ref")}
            field="image.ref"
            value={slide.image.ref}
            editable={editable}
            check={deckRefProblem}
            onCommit={(next, seed) => onText("image.ref", null, next, seed)}
          />
          <RefField
            label={fieldLabel("image.alt")}
            field="image.alt"
            value={slide.image.alt}
            editable={editable}
            onCommit={(next, seed) => onText("image.alt", null, next, seed)}
          />
        </div>
      ) : null}

      {hint ? <small className="dkv-hint">{hint}</small> : null}
      {!editable ? <p className="dkv-readonly">这个视图是只读的：它的组合没有声明提交动作。</p> : null}
    </section>
  );
}

interface RefFieldProps {
  label: string;
  field: string;
  value: string;
  editable: boolean;
  /** Refuse before proposing. Absent = any bounded text is fine. */
  check?(value: string): string | null;
  onCommit(next: string, seed: string): void;
}

/**
 * One property-strip field: shows the projection's value until focused, then
 * holds a draft until blur or Enter commits it. An invalid draft stays in the
 * box with its complaint next to it — committing it would propose an edit the
 * contract's reader is guaranteed to refuse.
 */
function RefField({ label, field, value, editable, check, onCommit }: RefFieldProps) {
  const [draft, setDraft] = useState<{ seed: string; text: string } | null>(null);
  const problem = draft ? (check?.(draft.text) ?? null) : null;

  const commit = () => {
    if (!draft) return;
    if (problem) return;
    setDraft(null);
    if (draft.text !== draft.seed) onCommit(draft.text, draft.seed);
  };

  return (
    <label className="dkv-prop" data-dkv-field={field} data-dkv-invalid={problem ? "1" : undefined}>
      <span className="dkv-prop-name">{label}</span>
      <AvInput
        type="text"
        aria-label={label}
        disabled={!editable}
        maxLength={DECK_LIMITS.maxTextLength}
        value={draft ? draft.text : value}
        onFocus={() => setDraft({ seed: value, text: value })}
        onChange={(event) => setDraft((current) => ({ seed: current?.seed ?? value, text: event.target.value }))}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          else if (event.key === "Escape") setDraft(null);
        }}
      />
      {problem ? <small className="dkv-problem">{problem}</small> : null}
    </label>
  );
}
