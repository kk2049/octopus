/**
 * The grid, purely presentational: positions in, one activation out.
 *
 * It renders every in-range position as an interactive gridcell — an empty
 * position is a legitimate target (that is how anything gets placed or moved
 * onto it), and whether an activation is ALLOWED is never this file's question.
 * The status branches are the point, as in every data.* component: "the path is
 * not there", "this is not a board" and "nothing has arrived yet" must read as
 * three different sentences.
 *
 * Keyboard: roving tabindex over the cells; arrows move focus, Enter/Space are
 * the buttons' native activation, so keys and clicks share one code path.
 */

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { cellKey, type BoardCell, type BoardStatus } from "../lib/board.js";

export interface BoardGridProposal {
  rid: string;
  from: string;
  to: string;
  phase: "inflight" | "refused";
  message: string;
  cell: BoardCell;
}

export interface BoardGridProps {
  rows: number;
  cols: number;
  cells: ReadonlyMap<string, BoardCell>;
  highlights: ReadonlySet<string>;
  /** The selected source cell in two-step interaction; null when none. */
  selected: string | null;
  disabled: boolean;
  busy: boolean;
  status: BoardStatus;
  /** The configured path, quoted back when it does not resolve. */
  source: string;
  /** No projection has arrived yet — checked before `status`, like the siblings. */
  booting: boolean;
  /** The last bounded refusal, "" when there is none. */
  refusal: string;
  /** Present when `refusal` came from a dismissible ledger entry. */
  refusalRid: string | null;
  /** One lifecycle overlay for this instance's configured action. */
  proposal: BoardGridProposal | null;
  label: string;
  onActivate(r: number, c: number): void;
  onDismissProposal(rid: string): void;
}

const BOARD_MOTION_MS = 180;
const REVERT_SETTLE_MS = BOARD_MOTION_MS + 40;
const REFUSAL_DISMISS_MS = 6_000;

const ARROWS: Record<string, [number, number]> = {
  ArrowUp: [-1, 0],
  ArrowDown: [1, 0],
  ArrowLeft: [0, -1],
  ArrowRight: [0, 1],
};

export function BoardGrid(props: BoardGridProps) {
  const {
    rows,
    cols,
    cells,
    highlights,
    selected,
    disabled,
    busy,
    status,
    source,
    booting,
    refusal,
    refusalRid,
    proposal,
    label,
    onActivate,
    onDismissProposal,
  } = props;
  const [focused, setFocused] = useState("0,0");
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const gridWrap = useRef<HTMLDivElement>(null);
  const rememberedCell = useRef<{ rid: string; cell: BoardCell } | null>(null);
  const reducedMotion = useReducedMotion();
  const [revertedRid, setRevertedRid] = useState<string | null>(null);
  const [floating, setFloating] = useState<FloatingGlyph | null>(null);
  // A board that shrank can strand the roving tabindex; fall back to the origin.
  const parts = focused.split(",").map(Number);
  const focusKey = parts[0]! < rows && parts[1]! < cols ? focused : cellKey(0, 0);
  const overlayVisible = Boolean(proposal && (proposal.phase === "inflight" || revertedRid !== proposal.rid));
  if (proposal && rememberedCell.current?.rid !== proposal.rid) {
    // Preserve the preview across the authoritative frame that lands before
    // the receipt; that frame may already have emptied the source position.
    rememberedCell.current = { rid: proposal.rid, cell: proposal.cell };
  }
  const proposalCell = proposal ? rememberedCell.current?.cell ?? proposal.cell : null;

  useEffect(() => {
    if (!proposal || proposal.phase !== "refused") {
      setRevertedRid(null);
      return;
    }
    const timer = window.setTimeout(
      () => setRevertedRid(proposal.rid),
      reducedMotion ? 0 : REVERT_SETTLE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [proposal?.phase, proposal?.rid, reducedMotion]);

  useEffect(() => {
    if (!proposal || proposal.phase !== "refused" || revertedRid !== proposal.rid) return;
    const timer = window.setTimeout(() => onDismissProposal(proposal.rid), REFUSAL_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [onDismissProposal, proposal?.phase, proposal?.rid, revertedRid]);

  useEffect(() => {
    if (!refusalRid) return;
    const timer = window.setTimeout(() => onDismissProposal(refusalRid), REFUSAL_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [onDismissProposal, refusalRid]);

  useLayoutEffect(() => {
    if (!proposal || !proposalCell || !overlayVisible || reducedMotion || !proposalCell.glyph) {
      setFloating(null);
      return;
    }
    const wrap = gridWrap.current;
    const from = buttons.current.get(proposal.from);
    const to = buttons.current.get(proposal.to);
    if (!wrap || !from || !to) {
      setFloating(null);
      return;
    }
    const wrapRect = wrap.getBoundingClientRect();
    const fromRect = from.getBoundingClientRect();
    const toRect = to.getBoundingClientRect();
    const metrics = {
      rid: proposal.rid,
      glyph: proposalCell.glyph,
      tone: proposalCell.tone,
      left: fromRect.left - wrapRect.left,
      top: fromRect.top - wrapRect.top,
      width: fromRect.width,
      height: fromRect.height,
      shiftX: toRect.left - fromRect.left,
      shiftY: toRect.top - fromRect.top,
    };
    let frame = 0;
    let nextFrame = 0;
    if (proposal.phase === "inflight") {
      setFloating({ ...metrics, at: "source", animate: false, direction: "out" });
      frame = window.requestAnimationFrame(() => {
        setFloating((current) =>
          current?.rid === proposal.rid
            ? { ...current, at: "target", animate: true }
            : current,
        );
      });
    } else {
      // Paint at the destination first, then transition back on the next frame.
      setFloating({ ...metrics, at: "target", animate: false, direction: "back" });
      frame = window.requestAnimationFrame(() => {
        nextFrame = window.requestAnimationFrame(() => {
          setFloating((current) =>
            current?.rid === proposal.rid
              ? { ...current, at: "source", animate: true }
              : current,
          );
        });
      });
    }
    return () => {
      window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(nextFrame);
    };
  }, [
    overlayVisible,
    proposal?.from,
    proposal?.phase,
    proposal?.rid,
    proposal?.to,
    proposalCell?.glyph,
    proposalCell?.tone,
    reducedMotion,
  ]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const arrow = ARROWS[event.key];
    if (!arrow || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    const [r, c] = focusKey.split(",").map(Number);
    const next = cellKey(
      Math.min(rows - 1, Math.max(0, r! + arrow[0])),
      Math.min(cols - 1, Math.max(0, c! + arrow[1])),
    );
    setFocused(next);
    buttons.current.get(next)?.focus();
  };

  return (
    <section className="bv-board" data-bv-source={source}>
      {booting ? (
        <p className="bv-note" role="note">⏳ 正在等待第一份投影…</p>
      ) : status === "missing" ? (
        <p className="bv-note" role="note">这个组合指向的投影路径不存在：<code>{source}</code></p>
      ) : status === "malformed" ? (
        <p className="bv-note" role="note"><code>{source}</code> 上不是一份可读的盘面（需要 rows、cols 和可选的 cells）。</p>
      ) : status === "too_large" ? (
        <p className="bv-note" role="note"><code>{source}</code> 的盘面超出了这个模块能渲染的尺寸。</p>
      ) : (
        <div
          ref={gridWrap}
          className="bv-grid-wrap"
          style={{ "--bv-motion-ms": `${BOARD_MOTION_MS}ms` } as CSSProperties}
        >
          <div
            role="grid"
            className="bv-grid"
            aria-label={label}
            aria-busy={busy || undefined}
            aria-disabled={disabled || busy || undefined}
            style={{ gridTemplateColumns: `repeat(${cols}, var(--bv-cell))` }}
            onKeyDown={onKeyDown}
          >
            {Array.from({ length: rows }, (_, r) => (
              <div role="row" className="bv-row" key={r}>
                {Array.from({ length: cols }, (_, c) => {
                  const key = cellKey(r, c);
                  const cell = cells.get(key);
                  const atTarget = Boolean(overlayVisible && proposal?.to === key);
                  const atSource = Boolean(overlayVisible && proposal?.from === key);
                  const shown = atTarget ? proposalCell : cell;
                  const classes = [
                    "bv-cell",
                    atTarget ? "bv-pending" : "",
                    atSource ? "bv-origin" : "",
                    proposal?.phase === "refused" && atTarget ? "bv-reverting" : "",
                  ].filter(Boolean).join(" ");
                  return (
                    <button
                      type="button"
                      role="gridcell"
                      key={key}
                      className={classes}
                      data-bv-cell={key}
                      data-bv-alt={(r + c) % 2 === 1 ? "" : undefined}
                      data-bv-hi={highlights.has(key) ? "" : undefined}
                      data-bv-tone={shown && shown.tone !== "neutral" ? shown.tone : undefined}
                      aria-label={atTarget ? `${shown?.label || key}，待确认` : cell?.label || key}
                      aria-selected={selected === key ? "true" : undefined}
                      disabled={disabled || busy}
                      tabIndex={disabled || busy ? -1 : key === focusKey ? 0 : -1}
                      ref={(el) => {
                        if (el) buttons.current.set(key, el);
                        else buttons.current.delete(key);
                      }}
                      onClick={() => {
                        setFocused(key);
                        onActivate(r, c);
                      }}
                    >
                      <span className={atTarget ? "bv-glyph bv-pending-glyph" : "bv-glyph"}>
                        {shown?.glyph || ""}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          {floating ? (
            <span
              className="bv-floating"
              data-bv-direction={floating.direction}
              data-bv-animate={floating.animate ? "" : undefined}
              data-bv-tone={floating.tone !== "neutral" ? floating.tone : undefined}
              aria-hidden="true"
              style={floatingStyle(floating)}
            >
              {floating.glyph}
            </span>
          ) : null}
        </div>
      )}
      {proposal?.phase === "refused" && revertedRid === proposal.rid ? (
        <div className="bv-note bv-refusal" role="status">
          <span>{proposal.message || "这次提议被拒绝了。"}</span>
          <button type="button" className="bv-dismiss" onClick={() => onDismissProposal(proposal.rid)}>
            清除
          </button>
        </div>
      ) : refusal ? (
        <div className="bv-note bv-refusal" role={refusalRid ? "status" : "note"}>
          <span>{refusal}</span>
          {refusalRid ? (
            <button type="button" className="bv-dismiss" onClick={() => onDismissProposal(refusalRid)}>
              清除
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

interface FloatingGlyph {
  rid: string;
  glyph: string;
  tone: BoardCell["tone"];
  left: number;
  top: number;
  width: number;
  height: number;
  shiftX: number;
  shiftY: number;
  at: "source" | "target";
  animate: boolean;
  direction: "out" | "back";
}

function floatingStyle(floating: FloatingGlyph): CSSProperties {
  return {
    left: floating.left,
    top: floating.top,
    width: floating.width,
    height: floating.height,
    "--bv-shift-x": `${floating.shiftX}px`,
    "--bv-shift-y": `${floating.shiftY}px`,
    transform: floating.at === "target" ? "translate(var(--bv-shift-x), var(--bv-shift-y))" : "translate(0, 0)",
  } as CSSProperties;
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}
