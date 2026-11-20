import { AvButton } from "@claude-bot/agent-view-react/ui";
/**
 * The film strip: every slide as a real 16:9 thumbnail, in order.
 *
 * ── Why the rows are thumbnails and not titles ──────────────────────────────
 *
 * A slide list that shows only titles is an outline of a deck, not the deck.
 * Each row here mounts the SAME `SlideSurface` the canvas renders — the four
 * layouts really laid out, the document's own theme colours — at rail width,
 * so the strip is the canvas at a distance rather than a second opinion of it.
 * The row's accessible name still carries the title (or 未命名), because a
 * thumbnail is not a name.
 *
 * ── Why deletion takes two clicks and no dialog ─────────────────────────────
 *
 * Decision 12 upgraded exactly one requirement: App code written wrong must not
 * cause large-scale data loss. A slide is the largest thing one click in this
 * package can destroy, and its inverse (`restore_slide`) is the one command the
 * channel cannot carry — so the client genuinely cannot offer undo. Arming the
 * button first is the cheapest control that matches that: it costs one extra
 * click and it needs no dialog primitive, no focus trap and no portal in a
 * sandboxed frame.
 *
 * ── Why the buttons are disabled rather than hidden while busy ──────────────
 *
 * A control that disappears mid-interaction moves everything under the pointer.
 * Disabled keeps the list still and says why in the same place.
 */

import type { ContractIssue, DeckLayout, DeckSlide, DeckTheme } from "@claude-bot/deck-model-contract";
import { LAYOUT_LABELS, UNTITLED } from "../lib/labels.js";
import { SourceNotice, sourceIsBlocked } from "./SourceNotice.js";
import { SlideSurface } from "./SlideSurface.js";
import type { DeckSourceStatus } from "../lib/deck-source.js";

export interface OutlineRow {
  id: string;
  slide: DeckSlide;
}

export interface DeckOutlineProps {
  title: string;
  deckTitle: string;
  status: DeckSourceStatus;
  source: string;
  issues: readonly ContractIssue[];
  rows: readonly OutlineRow[];
  theme: DeckTheme;
  selected: string | null;
  booting: boolean;
  emptyText: string;
  /** False when the instance has no `command_action`: the same strip, no controls. */
  editable: boolean;
  busy: boolean;
  /** The slide whose delete button is armed, if any. */
  arming: string | null;
  canExport: boolean;
  notice: string;
  domIdScope?: string;
  onSelect(id: string): void;
  onMove(id: string, delta: -1 | 1): void;
  onInsert(layout: DeckLayout): void;
  onArm(id: string | null): void;
  onRemove(id: string): void;
  onExport(): void;
}

const LAYOUTS: readonly DeckLayout[] = ["title", "bullets", "two-column", "image-ref"];

export function DeckOutline({
  title,
  deckTitle,
  status,
  source,
  issues,
  rows,
  theme,
  selected,
  booting,
  emptyText,
  editable,
  busy,
  arming,
  canExport,
  notice,
  domIdScope,
  onSelect,
  onMove,
  onInsert,
  onArm,
  onRemove,
  onExport,
}: DeckOutlineProps) {
  const scoped = (name: string): string => (domIdScope ? `dkv-${name}-${domIdScope}` : `dkv-${name}`);
  return (
    <section
      className="dkv-outline"
      data-dkv-source={source}
      data-dkv-status={status}
      aria-busy={busy || undefined}
    >
      <header className="dkv-head">
        <b>{title || "幻灯片"}</b>
        {deckTitle ? <span className="dkv-sub">{deckTitle}</span> : null}
        {busy ? <span className="dkv-tb-sync" role="status">同步中…</span> : null}
      </header>
      {sourceIsBlocked(status, booting) ? (
        <SourceNotice status={status} source={source} issues={issues} booting={booting} />
      ) : (
        <>
          {rows.length === 0 ? (
            <p className="dkv-note" role="note">{emptyText || "这份 deck 还没有任何一页。"}</p>
          ) : (
            <ol className="dkv-slides" id={scoped("slides")}>
              {rows.map((row, index) => (
                <li
                  key={row.id}
                  className="dkv-slide"
                  data-dkv-slide={row.id}
                  data-dkv-selected={row.id === selected ? "1" : undefined}
                >
                  <AvButton
                    className="dkv-pick"
                    aria-current={row.id === selected ? "true" : undefined}
                    aria-label={`第 ${index + 1} 页：${row.slide.title || UNTITLED}`}
                    onClick={() => onSelect(row.id)}
                  >
                    <span className="dkv-no">{index + 1}</span>
                    <span className="dkv-thumb">
                      <SlideSurface slide={row.slide} theme={theme} />
                    </span>
                  </AvButton>
                  {editable ? (
                    <span className="dkv-rowops">
                      <AvButton
                        title="上移"
                        aria-label={`上移第 ${index + 1} 页`}
                        data-dkv-up={row.id}
                        disabled={busy || index === 0}
                        onClick={() => onMove(row.id, -1)}
                      >
                        ↑
                      </AvButton>
                      <AvButton
                        title="下移"
                        aria-label={`下移第 ${index + 1} 页`}
                        data-dkv-down={row.id}
                        disabled={busy || index === rows.length - 1}
                        onClick={() => onMove(row.id, 1)}
                      >
                        ↓
                      </AvButton>
                      {arming === row.id ? (
                        <>
                          <AvButton
                            className="dkv-danger"
                            data-dkv-confirm={row.id}
                            disabled={busy}
                            onClick={() => onRemove(row.id)}
                          >
                            确认删除
                          </AvButton>
                          <AvButton data-dkv-cancel={row.id} onClick={() => onArm(null)}>
                            取消
                          </AvButton>
                        </>
                      ) : (
                        <AvButton
                          title="删除"
                          aria-label={`删除第 ${index + 1} 页`}
                          data-dkv-remove={row.id}
                          disabled={busy}
                          onClick={() => onArm(row.id)}
                        >
                          ✕
                        </AvButton>
                      )}
                    </span>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
          {notice ? <p className="dkv-notice" role="status">{notice}</p> : null}
          <div className="dkv-actions">
            {editable
              ? LAYOUTS.map((layout) => (
                  <AvButton
                    key={layout}
                    data-dkv-insert={layout}
                    disabled={busy}
                    onClick={() => onInsert(layout)}
                  >
                    ＋{LAYOUT_LABELS[layout]}
                  </AvButton>
                ))
              : <span className="dkv-readonly">只读</span>}
            {canExport ? (
              <AvButton className="dkv-export" data-dkv-export onClick={onExport}>
                导出 Typst
              </AvButton>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}
