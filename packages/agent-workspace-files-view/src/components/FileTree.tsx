import { AvButton } from "@claude-bot/agent-view-react/ui";
/**
 * The file tree — presentational, props-driven, and lazy by construction.
 *
 * It receives rows (already flattened by `visibleRows`) and four callbacks. It
 * holds no port, no cache and no expansion state, which is what lets a harness
 * render it from a fixture and what keeps "who owns this state" answerable.
 *
 * ── Three things it may not do ──────────────────────────────────────────────
 *
 *  · **Guess a path.** A row is addressed by the opaque ref its own listing
 *    carried. Nothing here concatenates a parent and a name, and nothing reads
 *    a label as if it meant a location.
 *  · **Offer to open what cannot be opened.** An `other` row has no ref, so it
 *    renders as text with no control at all — not a disabled button, no control.
 *    A regular file always opens a viewer, even when inline preview is
 *    unsupported; that viewer owns the bounded download fallback.
 *  · **Touch the layout.** Clicking a file calls `onOpenFile` with a structured
 *    link; where that link opens is the composition's decision.
 */

import type { ResourceLink } from "@claude-bot/agent-module-contract";
import { StatusChip } from "@claude-bot/agent-view-react/ui";
import {
  WORKSPACE_MEDIA_RESOURCE_KIND,
  WORKSPACE_TEXT_RESOURCE_KIND,
  isWorkspaceMediaLabel,
} from "@claude-bot/workspace-files-contract";
import type { ReactNode } from "react";
import { displaySize, type TreeRow } from "../lib/tree.js";
import type { ListedFileLocation } from "@claude-bot/agent-file-preview";

export interface FileTreeProps {
  rows: readonly TreeRow[];
  /** Roots enumeration state, for the header line. */
  rootsStatus: "idle" | "loading" | "ready" | "refused";
  rootsMessage: string;
  /** More workspaces follow the ones listed. */
  rootsTruncated: boolean;
  /** The next roots page: in flight, or its refusal. */
  rootsMore?: { loading: boolean; refusal: string };
  /** Load the next roots page. Absent: the note says more exist, with no control. */
  onLoadMoreRoots?(): void;
  /** Load a directory's next page (the trailing `more` row of its listing). */
  onLoadMore?(ref: string): void;
  /** The ref of the file most recently handed to `onOpenFile`. */
  selected: string | null;
  /** Whether dot-prefixed entries are currently being dropped from listings. */
  hideDotEntries?: boolean;
  onToggleHidden?(hidden: boolean): void;
  onRefresh(): void;
  onToggle(ref: string, expanded: boolean): void;
  onOpenFile(link: ResourceLink, location?: ListedFileLocation): void;
  /**
   * Open the same file in whichever module the composition named for editing.
   *
   * Absent when the composition named none — and then there is no button at
   * all, rather than a disabled one. This is a SECOND action on the same row:
   * a plain click still goes wherever `workspace-text` normally goes, which is
   * what keeps "opening a file" a read.
   */
  onEditFile?(link: ResourceLink, location?: ListedFileLocation): void;
  /** Distinguishes DOM ids when a composition mounts this module twice. */
  domIdScope?: string;
}

/**
 * Every icon a tree row may carry, in ONE 16×16 family (ticket #201).
 *
 * `device` and `parent` joined the set because the composing index drew those
 * two rows with emoji (`💻`, `↰`) while its file rows used these paths. Emoji
 * are a different size, a different baseline and a different colour on every
 * platform, so a rail that mixed them had three icon columns that never lined
 * up. A glyph here is `currentColor` at a fixed box, which is the whole reason
 * the column exists.
 */
export function FileTreeGlyph({
  kind,
  expanded = false,
}: {
  kind: TreeRow["kind"] | "refresh" | "edit" | "device" | "parent" | "eye" | "eye-off";
  expanded?: boolean;
}) {
  if (kind === "eye" || kind === "eye-off") {
    return (
      <svg className="wsglyph" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M8 3c3.3 0 5.9 2.4 6.9 5-1 2.6-3.6 5-6.9 5s-5.9-2.4-6.9-5C2.1 5.4 4.7 3 8 3Zm0 1.4c-2.5 0-4.6 1.7-5.5 3.6C3.4 9.9 5.5 11.6 8 11.6s4.6-1.7 5.5-3.6C12.6 6.1 10.5 4.4 8 4.4Zm0 1.4a2.2 2.2 0 1 1 0 4.4 2.2 2.2 0 0 1 0-4.4Z" />
        {kind === "eye-off" ? <path d="M2.4 1.5 14.5 13.6l-.9.9L1.5 2.4l.9-.9Z" /> : null}
      </svg>
    );
  }
  if (kind === "device") {
    return (
      <svg className="wsglyph wsglyph-device" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M1.5 2.5h13v9h-13v-9Zm1.3 1.3v6.4h10.4V3.8H2.8ZM4.5 13h7v1.2h-7V13Z" />
      </svg>
    );
  }
  if (kind === "parent") {
    return (
      <svg className="wsglyph wsglyph-folder" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M1.5 3.25h4.7l1.2 1.5h6.1v7.5h-12v-9Zm6.5 3.1L5.4 9h1.9v2.4h1.4V9h1.9L8 6.35Z" />
      </svg>
    );
  }
  if (kind === "directory") {
    return (
      <svg className="wsglyph wsglyph-folder" viewBox="0 0 16 16" aria-hidden="true">
        <path d={expanded
          ? "M1.5 4.75h13l-1.35 7.5H2.85L1.5 4.75Zm1-2h4l1.2 1.5H13a1 1 0 0 1 1 1H2v-2.5Z"
          : "M1.5 3.25h4.7l1.2 1.5h6.1v7.5h-12v-9Z"} />
      </svg>
    );
  }
  if (kind === "file") {
    return (
      <svg className="wsglyph" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M3 1.5h6l4 4v9H3v-13Zm6 1.4v3.6h3.6L9 2.9ZM5 9h6V8H5v1Zm0 2.5h6v-1H5v1Z" />
      </svg>
    );
  }
  if (kind === "refresh") {
    return (
      <svg className="wsglyph" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M13.2 3.8V1.5h1.3v4.7h-4.7V4.9h2.5A5 5 0 1 0 13 10.5l1.2.5a6.3 6.3 0 1 1-1-7.2Z" />
      </svg>
    );
  }
  if (kind === "edit") {
    return (
      <svg className="wsglyph" viewBox="0 0 16 16" aria-hidden="true">
        <path d="m11.8 1.6 2.6 2.6-8.5 8.5-3.4.8.8-3.4 8.5-8.5Zm-.9 2.7-6.5 6.5-.2.9.9-.2L11.6 5l-.7-.7Z" />
      </svg>
    );
  }
  return (
    <svg className="wsglyph" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2 2h12v12H2V2Zm2.2 3.1 1.7 1.7-1.7 1.7.9.9 2.6-2.6-2.6-2.6-.9.9Zm3.5 5.3h4.1V9.1H7.7v1.3Z" />
    </svg>
  );
}

/**
 * The one expand/collapse marker in the navigator (ticket #201).
 *
 * `open === null` renders the reserved-width placeholder a leaf needs, so a
 * file's icon sits in the same column as a folder's instead of 10px left of it.
 * Exported because the composing index has rows this component does not own —
 * a device header, a `..` node — and two markers that rotate differently is
 * exactly the inconsistency this exists to remove.
 */
export function FileTreeChevron({ open }: { open: boolean | null }) {
  if (open === null) return <span className="wschevron wschevron-placeholder" data-av-file-chevron aria-hidden="true" />;
  return (
    <span className="wschevron" data-av-file-chevron data-open={open ? "1" : undefined} aria-hidden="true">›</span>
  );
}

function rowTitle(row: TreeRow): string {
  const details = [
    row.sizeBytes === undefined ? "" : displaySize(row.sizeBytes),
    row.modifiedAt ? `修改于 ${row.modifiedAt}` : "",
  ].filter(Boolean);
  return details.length ? `${row.label} · ${details.join(" · ")}` : row.label;
}

export interface FileTreeRowProps {
  row: TreeRow;
  /** The ref of the file most recently opened, for `aria-selected`. */
  selected: string | null;
  /** Overrides the row's own depth for a surface that indents differently. */
  depth?: number;
  onToggle(ref: string, expanded: boolean): void;
  onOpenFile(link: ResourceLink, location?: ListedFileLocation): void;
  onEditFile?(link: ResourceLink, location?: ListedFileLocation): void;
  /** Load the next page of the directory a `more` row continues. */
  onLoadMore?(ref: string): void;
  /** Optional peer actions for a directory, supplied by a composing module. */
  directoryActions?: ReactNode;
}

/**
 * "加载更多": the trailing row of a listing with more pages (2026-10-20). One
 * page per press — a page is a capability call, never fetched speculatively.
 * Without a handler it still says more entries exist, rather than pretending
 * the listing ended.
 */
function MoreRow({ row, depth, onLoadMore }: { row: TreeRow; depth: number; onLoadMore?(ref: string): void }) {
  return (
    <li
      role="treeitem"
      className="wsrow wsrow-more"
      data-av-file-row="more"
      data-depth={depth}
      aria-level={depth + 1}
      aria-busy={row.loading || undefined}
      style={{ paddingInlineStart: `${depth * 12}px` }}
    >
      <div className="wsrow-main">
        {onLoadMore && row.moreOf ? (
          <AvButton
            className="wsmore"
            data-av-file-more
            data-ref={row.moreOf}
            disabled={row.loading === true}
            onClick={() => onLoadMore(row.moreOf!)}
          >
            <FileTreeChevron open={null} />
            {row.loading ? <><span className="wsrow-spinner" aria-hidden="true" />正在载入更多…</> : "加载更多"}
          </AvButton>
        ) : (
          <span className="wsmeta">还有更多条目</span>
        )}
      </div>
      {row.refusal ? (
        <div className="wsrow-feedback" role="note">
          <span className="wsrefusal" data-av-file-refusal>{row.refusal}</span>
        </div>
      ) : null}
    </li>
  );
}

/**
 * One row of a lazy file tree — the `data-av-file-*` hooks that a browser suite
 * reads from OUTSIDE the frame. Exported so a second surface
 * (the unified session/file index) renders file rows through this one
 * component instead of a lookalike that drifts.
 */
export function FileTreeRow({
  row,
  selected,
  depth,
  onToggle,
  onOpenFile,
  onEditFile,
  onLoadMore,
  directoryActions,
}: FileTreeRowProps) {
  const at = depth ?? row.depth;
  if (row.kind === "more") return <MoreRow row={row} depth={at} {...(onLoadMore ? { onLoadMore } : {})} />;
  const mediaPreview = isWorkspaceMediaLabel(row.label);
  return (
    <li
      role="treeitem"
      className="wsrow"
      data-av-file-row={row.kind}
      data-kind={row.kind}
      data-depth={at}
      data-loading={row.loading ? "1" : undefined}
      aria-level={at + 1}
      aria-busy={row.loading || undefined}
      aria-expanded={row.kind === "directory" && row.ref ? Boolean(row.expanded) : undefined}
      aria-selected={row.ref !== null && row.ref === selected ? true : undefined}
      style={{ paddingInlineStart: `${at * 12}px` }}
    >
      <div className="wsrow-main">
        {row.kind === "directory" && row.ref ? (
          <AvButton
            className="wsdir"
            data-av-file-directory
            data-ref={row.ref}
            title={rowTitle(row)}
            onClick={() => onToggle(row.ref!, Boolean(row.expanded))}
          >
            <FileTreeChevron open={Boolean(row.expanded)} />
            <FileTreeGlyph kind="directory" expanded={row.expanded} />
            <span className="wslabel">{row.label}</span>
            {row.sourceLabel ? <span className="wsmeta wsrow-detail">{row.sourceLabel}</span> : null}
          </AvButton>
        ) : null}
        {row.kind === "directory" ? directoryActions : null}
        {row.kind === "file" && row.ref ? (
          <AvButton
            className="wsfile"
            data-av-file
            data-ref={row.ref}
            title={rowTitle(row)}
            onClick={() => onOpenFile(fileLink(row), row.listedLocation)}
          >
            <FileTreeChevron open={null} />
            <FileTreeGlyph kind="file" />
            <span className="wslabel">{row.label}</span>
            {row.sizeBytes !== undefined ? (
              <span className="wsmeta wsrow-detail">{displaySize(row.sizeBytes)}</span>
            ) : null}
          </AvButton>
        ) : null}
        {row.kind === "file" && row.ref && onEditFile && !mediaPreview ? (
          <AvButton
            className="wsedit-open"
            data-ref={row.ref}
            aria-label={`编辑 ${row.label}`}
            // Saving has no size limit (a large save is staged in windows);
            // only a file past the whole-document budget, which the editor
            // could not hold whole, is not offered for editing.
            disabled={row.exceedsTextLimit === true}
            title={row.exceedsTextLimit ? "这个文件超过了整份载入编辑器的预算，可查看或下载" : "在编辑器里打开"}
            onClick={() => onEditFile(fileLink(row), row.listedLocation)}
          >
            <FileTreeGlyph kind="edit" />
            <span className="wsedit-word">编辑</span>
          </AvButton>
        ) : null}
        {row.kind === "other" ? (
          <span className="wsother" data-av-file-other title={`${row.label} · 不是普通文件或目录，无法打开`}>
            <FileTreeChevron open={null} />
            <FileTreeGlyph kind="other" />
            <span className="wslabel">{row.label}</span>
            <span className="wsmeta wsrow-detail">不可打开</span>
          </span>
        ) : null}
      </div>
      {row.loading || row.refusal ? (
        <div className="wsrow-feedback" role={row.loading ? "status" : "note"}>
          {row.loading ? <><span className="wsrow-spinner" aria-hidden="true" />正在载入目录…</> : null}
          {row.refusal ? <span className="wsrefusal" data-av-file-refusal>{row.refusal}</span> : null}
        </div>
      ) : null}
    </li>
  );
}

/**
 * The dot-entry knob (ticket #350).
 *
 * One control, exported, because two navigations render a tree and a knob that
 * existed on only one of them would make "are hidden entries showing" a
 * question with two answers. It is a plain toggle button rather than a checkbox
 * in a menu: it is the same 44px target on the phone layer as on the desktop
 * one, and the rail head is the only chrome that survives on both.
 */
export function HiddenEntriesToggle({
  id,
  hidden,
  onToggle,
}: {
  id?: string;
  hidden: boolean;
  onToggle(hidden: boolean): void;
}) {
  const word = hidden ? "显示隐藏项" : "隐藏 . 开头的项";
  return (
    <AvButton
      {...(id ? { id } : {})}
      className="wshidden-toggle"
      aria-pressed={hidden}
      aria-label={word}
      title={`${word}（以 . 开头的文件和目录）`}
      onClick={() => onToggle(hidden)}
    >
      <FileTreeGlyph kind={hidden ? "eye-off" : "eye"} />
    </AvButton>
  );
}

export function FileTree(props: FileTreeProps) {
  const id = (name: string): string => (props.domIdScope ? `${name}-${props.domIdScope}` : name);
  return (
    <section
      className="wsfiles"
      id={id("wsfiles")}
      data-av-file-tree
      aria-busy={props.rootsStatus === "loading" || undefined}
    >
      <div className="wsfiles-head">
        <span>工作区文件</span>
        {props.onToggleHidden ? (
          <HiddenEntriesToggle
            id={id("wsHidden")}
            hidden={props.hideDotEntries === true}
            onToggle={props.onToggleHidden}
          />
        ) : null}
        <AvButton id={id("wsRefresh")} aria-label="刷新" title="刷新" onClick={props.onRefresh}>
          <FileTreeGlyph kind="refresh" />
        </AvButton>
      </div>
      {props.rootsStatus === "loading" ? <StatusChip busy word="正在列出工作区" tone="info" /> : null}
      {props.rootsStatus === "refused" ? (
        <p className="wsrefusal" data-av-file-refusal role="note">
          {props.rootsMessage || "无法列出工作区。"}
        </p>
      ) : null}
      {props.rootsStatus === "ready" && !props.rows.length ? (
        <p className="wsmeta">这个账号还没有可浏览的工作区。</p>
      ) : null}
      <ul className="wstree" data-av-file-tree-rows role="tree">
        {props.rows.map((row) => (
          <FileTreeRow
            key={row.key}
            row={row}
            selected={props.selected}
            onToggle={props.onToggle}
            onOpenFile={props.onOpenFile}
            {...(props.onEditFile ? { onEditFile: props.onEditFile } : {})}
            {...(props.onLoadMore ? { onLoadMore: props.onLoadMore } : {})}
          />
        ))}
      </ul>
      {props.rootsTruncated ? (
        <MoreRoots
          {...(props.rootsMore ? { more: props.rootsMore } : {})}
          {...(props.onLoadMoreRoots ? { onLoadMore: props.onLoadMoreRoots } : {})}
        />
      ) : null}
    </section>
  );
}

/** "加载更多工作区": the roots answer is paged like a listing (2026-10-20). */
export function MoreRoots({
  more,
  onLoadMore,
}: {
  more?: { loading: boolean; refusal: string };
  onLoadMore?(): void;
}) {
  return (
    <div className="wsroots-more" data-av-file-roots-more>
      {onLoadMore ? (
        <AvButton className="wsmore" disabled={more?.loading === true} onClick={onLoadMore}>
          {more?.loading ? <><span className="wsrow-spinner" aria-hidden="true" />正在载入更多工作区…</> : "加载更多工作区"}
        </AvButton>
      ) : (
        <p className="wsmeta">还有更多工作区。</p>
      )}
      {more?.refusal ? <p className="wsrefusal" data-av-file-refusal role="note">{more.refusal}</p> : null}
    </div>
  );
}

/**
 * The structured link a click produces.
 *
 * The module names the resource kind, not its consumer. Choosing FileViewer,
 * CodeEditor or another compatible view is the composition's job; embedding a
 * suggested implementation here would couple this reusable producer to one App.
 */

function fileLink(row: TreeRow): ResourceLink {
  return {
    kind: isWorkspaceMediaLabel(row.label) ? WORKSPACE_MEDIA_RESOURCE_KIND : WORKSPACE_TEXT_RESOURCE_KIND,
    ref: row.ref!,
    label: row.label,
  };
}
