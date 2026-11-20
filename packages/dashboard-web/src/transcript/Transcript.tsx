/**
 * The one transcript renderer the trusted panel ships.
 *
 * ── Two properties that used to be in tension ───────────────────────────────
 *
 *  · **Long sessions must stay responsive.** A transcript of ten thousand
 *    entries used to be built as one `innerHTML` string. `@tanstack/react-virtual`
 *    renders the window that is on screen and measures rows as they appear, so
 *    cost tracks the viewport rather than the log.
 *  · **No data frame may collapse what the reader opened.** Every group is
 *    keyed by its stable message anchor, and work-fold choices live in this
 *    component as sticky overrides. Appends, prepends and running/result frames
 *    can all rebuild groups without taking ownership of that choice.
 *
 * Everything rendered here is untrusted (agent prose, tool input and output,
 * file paths, error text). It reaches the DOM as React children or through
 * `Markdown`, never as HTML.
 */

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  DASHBOARD_CHAT_CLASSES,
} from "./ChatTranscript.js";
import {
  TranscriptGroupView,
  type TranscriptGroupClasses,
} from "./TranscriptGroup.js";
import { Markdown } from "../ui/Markdown.js";
import { Spinner } from "../ui/misc.js";
import { groupEntries, type ViewEntry } from "../lib/transcript.js";
import styles from "./Transcript.module.css";

/** The trusted panel's class mapping, shared with `SessionChat`. */
export const GROUP_CLASSES: TranscriptGroupClasses = {
  ...DASHBOARD_CHAT_CLASSES,
};

function renderAssistant(text: string) {
  return <Markdown>{text}</Markdown>;
}

function renderSpinner() {
  return <Spinner />;
}

function GroupView({
  group,
  expanded,
  onToggle,
  expansionOverrides,
  onToggleExpansion,
}: {
  group: ReturnType<typeof groupEntries>[number];
  expanded?: boolean;
  onToggle: (open: boolean) => void;
  expansionOverrides: Readonly<Record<string, boolean>>;
  onToggleExpansion: (key: string, open: boolean) => void;
}) {
  return (
    <TranscriptGroupView
      classes={GROUP_CLASSES}
      group={group}
      renderAssistant={renderAssistant}
      renderSpinner={renderSpinner}
      {...(expanded !== undefined ? { expanded } : {})}
      onToggle={onToggle}
      expansionOverrides={expansionOverrides}
      onToggleExpansion={onToggleExpansion}
    />
  );
}

export interface TranscriptProps {
  entries: readonly ViewEntry[];
  /** The session is blocked on a tool right now (see `groupEntries`). */
  running?: boolean;
  /** Rendered after the last group — operation chips, activity strip, etc. */
  footer?: React.ReactNode;
  /** Scroll to the bottom whenever this value changes and the reader is pinned. */
  followKey?: unknown;
  /** Preserve the distance from the bottom across a prepend (load earlier). */
  anchorTop?: unknown;
  className?: string;
}

/** Rows below this count render without a virtualizer; measurement costs more. */
const VIRTUALIZE_THRESHOLD = 40;

export function Transcript({
  entries,
  running,
  footer,
  followKey,
  anchorTop,
  className,
}: TranscriptProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const groups = useMemo(() => groupEntries(entries, running), [entries, running]);
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const onToggleGroup = useCallback(
    (key: string, open: boolean) => setOverrides((previous) => ({ ...previous, [key]: open })),
    [],
  );
  const virtualize = groups.length > VIRTUALIZE_THRESHOLD;

  const virtualizer = useVirtualizer({
    count: groups.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => groups[index]!.key,
    estimateSize: () => 96,
    overscan: 12,
    enabled: virtualize,
  });

  const pinnedRef = useRef(true);
  // The anchor for a prepend is the distance from the BOTTOM — a prepend does
  // not change it, while it shifts `scrollTop` by the whole added height. It is
  // kept current on every scroll and after every follow, because by the time the
  // new messages are in the DOM the old measurement is already gone.
  const bottomGapRef = useRef(0);
  const anchorSeen = useRef(anchorTop);

  // Pinned-to-bottom follow. Writing `scrollTop` in a layout effect — before the
  // browser paints — keeps the jump from being visible.
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    if (pinnedRef.current) node.scrollTop = node.scrollHeight;
    bottomGapRef.current = node.scrollHeight - node.scrollTop;
  }, [followKey]);

  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node || anchorSeen.current === anchorTop) return;
    anchorSeen.current = anchorTop;
    node.scrollTop = node.scrollHeight - bottomGapRef.current;
  }, [anchorTop]);

  const onScroll = () => {
    const node = scrollRef.current;
    if (!node) return;
    pinnedRef.current = node.scrollTop + node.clientHeight >= node.scrollHeight - 60;
    bottomGapRef.current = node.scrollHeight - node.scrollTop;
  };

  if (!virtualize) {
    return (
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className={className
          ? `${DASHBOARD_CHAT_CLASSES.transcript} ${styles.scroll} ${className}`
          : `${DASHBOARD_CHAT_CLASSES.transcript} ${styles.scroll}`}
      >
        {groups.map((group) => (
          <GroupView
            key={group.key}
            group={group}
            expanded={overrides[group.key]}
            onToggle={(open) => onToggleGroup(group.key, open)}
            expansionOverrides={overrides}
            onToggleExpansion={onToggleGroup}
          />
        ))}
        {footer}
      </div>
    );
  }

  const items = virtualizer.getVirtualItems();
  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className={className
        ? `${DASHBOARD_CHAT_CLASSES.transcript} ${styles.scroll} ${className}`
        : `${DASHBOARD_CHAT_CLASSES.transcript} ${styles.scroll}`}
    >
      <div className={styles.virtualBox} style={{ height: `${virtualizer.getTotalSize()}px` }}>
        {items.map((item) => (
          <div
            key={groups[item.index].key}
            data-index={item.index}
            ref={virtualizer.measureElement}
            className={styles.virtualRow}
            style={{ transform: `translateY(${item.start}px)` }}
          >
            <GroupView
              group={groups[item.index]}
              expanded={overrides[groups[item.index].key]}
              onToggle={(open) => onToggleGroup(groups[item.index].key, open)}
              expansionOverrides={overrides}
              onToggleExpansion={onToggleGroup}
            />
          </div>
        ))}
      </div>
      {footer}
    </div>
  );
}
