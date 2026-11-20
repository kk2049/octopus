import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";

/** One scroll owner for the outer groups and an unusually long expanded run. */
export const TranscriptScrollContext = createContext<RefObject<HTMLDivElement | null> | null>(null);
export const TRANSCRIPT_STATIC_ROW_LIMIT = 40;
const ESTIMATE = 112;

export function VirtualTranscriptRows<T>({
  rows, itemKey, renderRow, target,
}: {
  rows: readonly T[];
  itemKey(row: T): string;
  renderRow(row: T, index: number): ReactNode;
  target?: { index: number; request: number } | null;
}) {
  const scroll = useContext(TranscriptScrollContext);
  const list = useRef<HTMLDivElement>(null);
  const [margin, setMargin] = useState(0);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const virtual = Boolean(scroll && rows.length > TRANSCRIPT_STATIC_ROW_LIMIT);
  const keys = useMemo(() => rows.map(itemKey), [rows, itemKey]);
  const getItemKey = useCallback((index: number) => keys[index]!, [keys]);
  const selectedIndexes = useMemo(() => selected.map((key) => keys.indexOf(key)).filter((index) => index >= 0), [keys, selected]);
  const rangeExtractor = useCallback((range: Parameters<typeof defaultRangeExtractor>[0]) =>
    [...new Set([...defaultRangeExtractor(range), ...selectedIndexes])].sort((a, b) => a - b), [selectedIndexes]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroll?.current ?? null,
    getItemKey,
    estimateSize: () => ESTIMATE,
    overscan: 8,
    // React 19 layout/measurement callbacks must not enter a nested flushSync.
    useFlushSync: false,
    scrollMargin: margin,
    enabled: virtual,
    initialRect: { width: 800, height: 720 },
    initialOffset: () => scroll?.current?.scrollTop ?? Math.max(0, rows.length * ESTIMATE - 720),
    rangeExtractor,
  });
  useLayoutEffect(() => {
    if (!virtual || !list.current || !scroll?.current) return;
    const node = list.current, container = scroll.current;
    const measure = () => {
      const next = node.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
      setMargin((previous) => Math.abs(previous - next) < 0.5 ? previous : next);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    observer.observe(container);
    return () => observer.disconnect();
  }, [scroll, virtual]);
  useEffect(() => {
    if (!virtual) return;
    const retainSelection = () => {
      const node = list.current, selection = document.getSelection();
      const next: string[] = [];
      if (node && selection && !selection.isCollapsed && selection.rangeCount) {
        const range = selection.getRangeAt(0);
        for (const row of node.querySelectorAll<HTMLElement>(":scope > [data-av-virtual-row]")) {
          if (range.intersectsNode(row) && row.dataset.avVirtualRow) next.push(row.dataset.avVirtualRow);
        }
      }
      setSelected((previous) => previous.length === next.length && previous.every((key, index) => key === next[index]) ? previous : next);
    };
    document.addEventListener("selectionchange", retainSelection);
    return () => document.removeEventListener("selectionchange", retainSelection);
  }, [virtual]);
  useLayoutEffect(() => {
    if (!target) return;
    if (virtual) virtualizer.scrollToIndex(target.index, { align: "center" });
    else list.current?.children[target.index]?.scrollIntoView?.({ block: "center" });
  }, [target?.request, virtual, virtualizer]);
  if (!virtual) return <div ref={list} className="av-chat-rows">{rows.map((row, index) => <div key={itemKey(row)}>{renderRow(row, index)}</div>)}</div>;
  return <div ref={list} className="av-chat-rows" data-av-virtual-list style={{ height: virtualizer.getTotalSize(), position: "relative", overflowAnchor: "none" }}>
    {virtualizer.getVirtualItems().map((item) => <div
      key={item.key}
      data-index={item.index}
      data-av-virtual-row={keys[item.index]}
      ref={virtualizer.measureElement}
      style={{ position: "absolute", top: 0, left: 0, width: "100%", display: "flow-root", transform: `translateY(${item.start - margin}px)` }}
    >{renderRow(rows[item.index]!, item.index)}</div>)}
  </div>;
}
