import { useEffect, useRef, type ReactNode } from "react";
import { clampWindow, detailWindowSize, type WorkWindow } from "./state.js";
export function WindowFrame({
  window,
  title,
  icon,
  children,
  change,
  close,
  viewport,
  screenPosition,
  canvasZoom = 1,
  hidden = false,
  compact = false,
}: {
  window: WorkWindow;
  title: string;
  icon: string;
  children: ReactNode;
  change(patch: Partial<WorkWindow>): void;
  close(): void;
  viewport: { width: number; height: number; offsetTop?: number; visibleHeight?: number };
  screenPosition?: { x: number; y: number };
  canvasZoom?: number;
  hidden?: boolean;
  compact?: boolean;
}) {
  const body = useRef<HTMLDivElement>(null),
    lastScroll = useRef(window.scroll ?? 0);
  const content = useRef<HTMLDivElement>(null),
    restoring = useRef(true);
  useEffect(() => {
    restoring.current = true;
    const restore = () => {
      if (!body.current || !restoring.current) return;
      body.current.scrollTop = window.scroll ?? 0;
      if (body.current.scrollTop >= (window.scroll ?? 0))
        restoring.current = false;
    };
    restore();
    if (!content.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(restore);
    observer.observe(content.current);
    return () => observer.disconnect();
  }, [window.id, window.minimized, hidden]);
  // Fixed geometry tiers avoid fractional CSS scaling and preserve native DOM
  // glyphs. The component stays mounted when zoom changes, so drafts/scroll
  // retain their identity.
  const tier = compact ? { width: viewport.width, height: viewport.visibleHeight ?? viewport.height } : detailWindowSize(canvasZoom, viewport);
  const left = compact ? 0 : screenPosition?.x ?? window.x, top = compact ? viewport.offsetTop ?? 0 : screenPosition?.y ?? window.y;
  return (
    <section
      className="rv-window"
      data-window={window.id}
      aria-label={title}
      style={{
        display: hidden || window.minimized ? "none" : undefined,
        left,
        top,
        width: tier.width,
        height: tier.height,
        resize: "none",
        zIndex: compact ? 2000000025 : 20 + window.z,
      }}
      onPointerDown={() => change({ z: Date.now() % 1_000_000_000 })}
    >
      <header
        className="rv-window-header"
        onPointerDown={(event) => {
          if (compact || (event.target as Element).closest("button")) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          const x = event.clientX,
            y = event.clientY,
            initial = { ...window, ...tier, x: left, y: top };
          const move = (next: PointerEvent) =>
            change(
              clampWindow(
                {
                  ...initial,
                  x: initial.x + next.clientX - x,
                  y: initial.y + next.clientY - y,
                },
                viewport.width,
                viewport.height,
              ),
            );
          const element = event.currentTarget;
          const end = () => {
            element.removeEventListener("pointermove", move);
            element.removeEventListener("pointerup", end);
            element.removeEventListener("pointercancel", end);
          };
          element.addEventListener("pointermove", move);
          element.addEventListener("pointerup", end);
          element.addEventListener("pointercancel", end);
        }}
      >
        <span>{icon}</span>
        <h2>{title}</h2>
        <button
          aria-label="最小化窗口"
          onClick={() => change({ minimized: true })}
        >
          —
        </button>
        <button aria-label="关闭窗口" onClick={close}>
          ×
        </button>
      </header>
      <div
        ref={body}
        className="rv-window-body"
        onWheel={() => {
          restoring.current = false;
        }}
        onPointerDown={() => {
          restoring.current = false;
        }}
        onScroll={(event) => {
          const top = event.currentTarget.scrollTop;
          if (restoring.current) return;
          if (Math.abs(top - lastScroll.current) > 8) {
            lastScroll.current = top;
            change({ scroll: top });
          }
        }}
      >
        <div ref={content}>{children}</div>
      </div>
    </section>
  );
}
