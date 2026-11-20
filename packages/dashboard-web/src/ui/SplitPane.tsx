import { useDashboardLanguage } from "../i18n/react.js";
import { uiText } from "../i18n/ui-text.js";
/**
 * Resizable columns and rows, on `react-resizable-panels`.
 *
 * The retired implementation was ~80 lines of pointer-event handling in a
 * template string. It worked with a mouse and it persisted widths, but the
 * divider was a `<div>` with no role, no `tabindex` and no keyboard handling —
 * so the layout of the three widest pages in the panel could only be changed by
 * dragging. The library ships the WAI-ARIA `separator` semantics, arrow-key
 * resizing, touch support and `autoSaveId` persistence.
 *
 * Persistence writes a layout percentage to `localStorage` under the key given.
 * That is a display preference and nothing else: no identifier, no credential
 * and no server data is stored, which is the rule for this app.
 *
 * A group may be vertical (ticket #61), and a panel may be COLLAPSIBLE: the
 * ticket page opens with its conversation collapsed and the agent transcript
 * holding the whole pane, then expands to whatever height the reader dragged
 * it to last. Collapsing stays a size change rather than a conditional render
 * on purpose — the transcript below keeps its scroll position, and the
 * conversation keeps its own, because neither subtree is ever unmounted.
 */

import type { ReactNode, Ref } from "react";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type ImperativePanelHandle,
} from "react-resizable-panels";
import styles from "./SplitPane.module.css";

export type { ImperativePanelHandle };

export interface SplitPaneProps {
  /** Stable key for the persisted layout, e.g. `sessions`. */
  id: string;
  children: ReactNode;
  className?: string;
  /** Columns by default; `vertical` stacks its panels into rows. */
  direction?: "horizontal" | "vertical";
}

/** A resizable group whose layout is remembered per browser. */
export function SplitPane({ id, children, className, direction = "horizontal" }: SplitPaneProps) {
  const classes = [styles.group, direction === "vertical" ? styles.vgroup : "", className]
    .filter(Boolean)
    .join(" ");
  return (
    <PanelGroup direction={direction} autoSaveId={`octopus.pane.${id}`} className={classes}>
      {children}
    </PanelGroup>
  );
}

export interface SplitPanelProps {
  children: ReactNode;
  defaultSize: number;
  minSize?: number;
  maxSize?: number;
  className?: string;
  order?: number;
  id?: string;
  /** May be collapsed to `collapsedSize` by a drag or through the handle below. */
  collapsible?: boolean;
  collapsedSize?: number;
  onCollapse?: () => void;
  onExpand?: () => void;
  /** Imperative collapse/expand, for a caller that owns a disclosure control. */
  panelRef?: Ref<ImperativePanelHandle>;
}

export function SplitPanel({
  children,
  defaultSize,
  minSize = 10,
  maxSize,
  className,
  order,
  id,
  collapsible,
  collapsedSize,
  onCollapse,
  onExpand,
  panelRef,
}: SplitPanelProps) {
  return (
    <Panel
      id={id}
      ref={panelRef}
      order={order}
      defaultSize={defaultSize}
      minSize={minSize}
      maxSize={maxSize}
      collapsible={collapsible}
      collapsedSize={collapsedSize}
      onCollapse={onCollapse}
      onExpand={onExpand}
      className={className ? `${styles.panel} ${className}` : styles.panel}
    >
      {children}
    </Panel>
  );
}

/** The draggable divider. Focusable, arrow-key resizable, labelled. */
export function SplitHandle({
  label = uiText("调整宽度"),
  direction = "horizontal",
}: {
  label?: string;
  direction?: "horizontal" | "vertical";
}) {
  useDashboardLanguage();
  return (
    <PanelResizeHandle
      className={direction === "vertical" ? `${styles.handle} ${styles.vhandle}` : styles.handle}
      aria-label={label}
      title={label}
    />
  );
}
