import { AvButton } from "@claude-bot/agent-view-react/ui";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { DirectorySessionMatch } from "../lib/directory-sessions.js";
import { SessionFamilyRow as SessionRow } from "./SessionFamilies.js";

export interface DirectorySessionsDialogProps {
  open: boolean;
  directoryLabel: string;
  matches: readonly DirectorySessionMatch[];
  selected: string | null;
  pinned: readonly string[];
  /** The directory marker this compact list stays beside. */
  anchorRef: RefObject<HTMLElement | null>;
  onClose(): void;
  onSelect(resourceId: string): void;
}

interface Placement {
  left: number;
  width: number;
  top: number;
  minHeight: number;
  maxHeight: number;
}

const POPOVER_WIDTH = 240;
const POPOVER_MIN_HEIGHT = 220;
const VIEWPORT_GAP = 8;

type ResizeEdge = "left" | "right";

interface ResizeDrag {
  pointerId: number;
  node: HTMLDivElement;
  edge: ResizeEdge;
  startX: number;
  left: number;
  width: number;
  owner: HTMLElement;
}

/** A small non-modal picker kept beside one navigation-directory marker. */
export function DirectorySessionsDialog({
  open,
  directoryLabel,
  matches,
  selected,
  pinned,
  anchorRef,
  onClose,
  onSelect,
}: DirectorySessionsDialogProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);
  // This component belongs to a stable directory row. Data frames and closing
  // the picker must not reset an explicit size; a new View starts fresh.
  const [horizontal, setHorizontal] = useState<{ width: number; anchorOffset: number } | null>(null);
  const dragRef = useRef<ResizeDrag | null>(null);

  const finishResize = useCallback(() => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    drag.owner.classList.remove("av-resizing-x");
    try {
      drag.node.releasePointerCapture(drag.pointerId);
    } catch {
      // The pointer may already have been cancelled or the node removed.
    }
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    const place = (): void => {
      const anchor = anchorRef.current;
      if (!anchor || !anchor.isConnected) {
        setPlacement(null);
        return;
      }
      let ancestor: HTMLElement | null = anchor;
      while (ancestor) {
        const style = window.getComputedStyle(ancestor);
        if (style.display === "none" || style.visibility === "hidden") {
          setPlacement(null);
          return;
        }
        ancestor = ancestor.parentElement;
      }
      const bounds = anchor.getBoundingClientRect();
      const width = Math.min(horizontal?.width ?? POPOVER_WIDTH, Math.max(0, window.innerWidth - VIEWPORT_GAP * 2));
      const opensRight = window.innerWidth - bounds.right - VIEWPORT_GAP - 6 >= width;
      const preferredLeft = horizontal ? bounds.right + horizontal.anchorOffset : opensRight
        ? bounds.right + 6
        : bounds.left - width - 6;
      const left = Math.max(VIEWPORT_GAP, Math.min(preferredLeft, window.innerWidth - width - VIEWPORT_GAP));
      const minHeight = Math.min(POPOVER_MIN_HEIGHT, Math.max(0, window.innerHeight - VIEWPORT_GAP * 2));
      const top = Math.min(
        Math.max(VIEWPORT_GAP, bounds.top),
        Math.max(VIEWPORT_GAP, window.innerHeight - minHeight - VIEWPORT_GAP),
      );
      setPlacement({
        left,
        width,
        top,
        minHeight,
        maxHeight: Math.max(minHeight, window.innerHeight - top - VIEWPORT_GAP),
      });
    };
    place();
    const resizeObserver = new ResizeObserver(place);
    if (anchorRef.current) resizeObserver.observe(anchorRef.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchorRef, horizontal, open]);

  const visible = open && placement !== null;
  useEffect(() => {
    if (!visible) return;
    window.addEventListener("blur", finishResize);
    window.addEventListener("resize", finishResize);
    return () => {
      finishResize();
      window.removeEventListener("blur", finishResize);
      window.removeEventListener("resize", finishResize);
    };
  }, [finishResize, visible]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (surfaceRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onClose();
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [anchorRef, onClose, open]);

  const resize = (edge: ResizeEdge, left: number, width: number, delta: number): void => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const minWidth = Math.min(POPOVER_WIDTH, Math.max(0, window.innerWidth - VIEWPORT_GAP * 2));
    const right = left + width;
    const nextLeft = edge === "left" ? Math.max(VIEWPORT_GAP, Math.min(left + delta, right - minWidth)) : left;
    const nextRight = edge === "right" ? Math.min(window.innerWidth - VIEWPORT_GAP, Math.max(right + delta, left + minWidth)) : right;
    setHorizontal({ width: nextRight - nextLeft, anchorOffset: nextLeft - anchor.getBoundingClientRect().right });
  };

  const startResize = (edge: ResizeEdge, event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || !placement || dragRef.current) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    dragRef.current = {
      pointerId: event.pointerId,
      node: event.currentTarget,
      edge,
      startX: event.clientX,
      left: placement.left,
      width: placement.width,
      owner: event.currentTarget.closest<HTMLElement>("[data-app-surface]") ?? document.body,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current.owner.classList.add("av-resizing-x");
  };

  if (!open || !placement) return null;
  const style: CSSProperties = {
    left: `${placement.left}px`,
    width: `${placement.width}px`,
    top: `${placement.top}px`,
    minHeight: `${placement.minHeight}px`,
    maxHeight: `${placement.maxHeight}px`,
  };
  return createPortal(
    <div
      ref={surfaceRef}
      className="directory-sessions-popover"
      data-av-directory-sessions
      role="dialog"
      aria-label={`「${directoryLabel || "目录"}」下的会话`}
      style={style}
    >
      {(["left", "right"] as const).map((edge) => (
        <div
          key={edge}
          className="directory-sessions-resize"
          data-av-resize-edge={edge}
          role="separator"
          tabIndex={0}
          aria-label={`拖动${edge === "left" ? "左" : "右"}边框调整会话列表宽度`}
          aria-orientation="vertical"
          aria-valuemin={Math.min(POPOVER_WIDTH, window.innerWidth - VIEWPORT_GAP * 2)}
          aria-valuemax={edge === "left" ? placement.left + placement.width - VIEWPORT_GAP : window.innerWidth - placement.left - VIEWPORT_GAP}
          aria-valuenow={placement.width}
          title="拖动调整宽度，双击恢复默认"
          onPointerDown={(event) => startResize(edge, event)}
          onPointerMove={(event) => {
            const drag = dragRef.current;
            if (drag?.pointerId === event.pointerId) resize(drag.edge, drag.left, drag.width, event.clientX - drag.startX);
          }}
          onPointerUp={(event) => { if (dragRef.current?.pointerId === event.pointerId) finishResize(); }}
          onPointerCancel={(event) => { if (dragRef.current?.pointerId === event.pointerId) finishResize(); }}
          onLostPointerCapture={(event) => { if (dragRef.current?.pointerId === event.pointerId) finishResize(); }}
          onDoubleClick={() => setHorizontal(null)}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            resize(edge, placement.left, placement.width, (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 40 : 10));
          }}
        />
      ))}
      <div className="directory-sessions-head">
        <span>「{directoryLabel || "目录"}」下的会话</span>
        <AvButton aria-label="关闭目录会话列表" tone="quiet" onClick={onClose}>×</AvButton>
      </div>
      <div className="directory-sessions-list">
        {matches.length ? matches.map(({ session, depth }) => (
          <div className="directory-session" key={session.resourceId}>
            <span className="directory-session-depth">
              {depth === 0 ? "当前目录" : `下 ${depth} 层`}
            </span>
            <SessionRow
              session={session}
              depth={0}
              flat={false}
              selected={selected}
              pinned={pinned}
              onSelect={(resourceId) => {
                onSelect(resourceId);
                onClose();
              }}
            />
          </div>
        )) : <p className="small">当前已列出的子树里没有会话。</p>}
      </div>
    </div>,
    anchorRef.current?.closest<HTMLElement>("[data-app-surface]") ?? document.body,
  );
}
