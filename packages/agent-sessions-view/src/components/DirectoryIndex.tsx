import { createContext, useContext, useMemo, useState } from "react";
import { AvButton } from "@claude-bot/agent-view-react/ui";
import { useCallback, useEffect, useRef, type RefCallback } from "react";
/**
 * The file-centred navigation index, with a session-only degradation when a
 * composition did not wire the files port.
 *
 * Presentational and props-driven, like every component in this package: the
 * File rows render through the files package's own `FileTreeRow` (so the
 * `wsdir`/`wsfile` markup a browser suite reads from outside the frame has one
 * source), and
 * session rows reuse `SessionRow`. Session markers use only exact directory
 * keys from the already listed lazy subtree. Nothing here reaches for a port.
 *
 * File refs cannot be used as launch paths. File mode instead derives a
 * display-only prefill from the trusted device id plus a resolvable `~/…`
 * navigation coordinate, so every ordinary folder gets `＋`; the Runner still
 * validates the submitted directory. The global "start anywhere" entry remains
 * for a new or redacted location the navigator cannot name.
 *
 * The per-device access line renders the trusted side's own words about the
 * workspace-plane operations (list / read / write). It is deliberately at the
 * DEVICE level: the permission model grants (owner, operation), not
 * directories, and a per-directory badge would claim an authorization that
 * does not exist.
 *
 * ── What `narrow` changes, and what it may not (ticket #181) ───────────────
 *
 * On the phone layer the whole rail is ONE screen, so anything standing above
 * the tree is paid for in rows the user came here to read. Two things step
 * back there: the rail's refresh control (the index already re-lists on mount
 * and on every Runner wake, so the manual copy is a convenience, not the only
 * path to fresh data) and the access chips, which fold into a closed
 * disclosure. Folded, NOT dropped: "write: unavailable" is the answer to why a
 * save will fail, and a surface that silently omitted it on one viewport would
 * be lying by layout. The chips keep their words, their tone and their order —
 * `narrow` moves them behind one summary line and nothing else.
 */

import type { ResourceLink } from "@claude-bot/agent-module-contract";
import type { SourceRow, WorkspaceAccessRow, WorkspaceGroup } from "@claude-bot/agent-sessions-contract";
import type { WorkspaceFilesRoots } from "@claude-bot/workspace-files-contract";
import {
  FileTreeChevron,
  FileTreeGlyph,
  FileTreeRow,
  HiddenEntriesToggle,
  MoreRoots,
  type DirectoryCache,
  type ExpandedDirectories,
  type ListedFileLocation,
  type TreeRow,
} from "@claude-bot/agent-workspace-files-view";
import { directoryIndexRows, type IndexRow } from "../lib/directory-index.js";
import { createDirectorySessionsIndex } from "../lib/directory-sessions.js";
import {
  homeDirectoryRows,
  type DirectoryLaunchTarget,
  type HomeDirectoryRow,
} from "../lib/home-directory-tree.js";
import { isResolvableDir, type RosterSession } from "../lib/roster.js";
import { scopedDomId } from "../lib/dom.js";
import { DirectorySessionsDialog } from "./DirectorySessionsDialog.js";
import { SessionFamilies, SessionFamilyRow as SessionRow } from "./SessionFamilies.js";

export interface SessionDirectoryTarget {
  ref: string;
  directoryKey?: string;
  label: string;
}

export interface DirectoryIndexProps {
  sharedOnly?: boolean;
  domIdScope?: string;
  indexPending?: boolean;
  sources?: readonly SourceRow[];
  sessions: readonly RosterSession[];
  pinned: readonly string[];
  selected: string | null;
  /** Device / directory / workspace expansion, by row key. Display state. */
  expanded: Readonly<Record<string, boolean>>;
  workspacesByDevice: Readonly<Record<string, WorkspaceGroup>>;
  devices?: readonly string[];
  /** The trusted side's workspace-plane standing rows; [] renders nothing. */
  access: readonly WorkspaceAccessRow[];
  /** Files plane, when this composition wired one. */
  roots: WorkspaceFilesRoots | null;
  rootsStatus: "idle" | "loading" | "ready" | "refused";
  rootsMessage: string;
  /** The sessions plane is displaying a useful cache-backed progressive frame. */
  refreshing?: boolean;
  cache: DirectoryCache;
  expandedDirs: ExpandedDirectories;
  selectedFile: string | null;
  /** Completed cwd reveal to scroll into view after its expanded row renders. */
  revealDirectory?: { requestId: number; ref: string } | null;
  /** True when the composition supplied the file plane; false is degradation. */
  showFiles: boolean;
  /**
   * The shell's narrow (phone) layer, as reported by the layout kernel's own
   * media query. Presentation only: it changes which chrome stands open, never
   * which rows exist, which port is called, or what a row is allowed to say.
   */
  narrow?: boolean;
  /**
   * Dot-prefixed entries are dropped from the listings this index renders.
   *
   * Unlike `narrow`, this one is the reader's own decision and therefore stands
   * on BOTH layers: a home directory with thirty dotfiles in it is exactly as
   * unbrowsable on a phone as on a desktop (ticket #350).
   */
  hideDotEntries: boolean;
  onToggleHidden(hidden: boolean): void;
  sessionDirectory: SessionDirectoryTarget | null;
  onOpenSessions(directory: SessionDirectoryTarget): void;
  onCloseSessions(): void;
  onRefresh(): void;
  onSelect(resourceId: string): void;
  /** `open` is what the row is showing right now; the caller just flips it. */
  onToggle(key: string, open: boolean): void;
  /** Toggle one file-layer directory (by opaque ref). */
  onToggleDir(ref: string, expanded: boolean): void;
  /** A joined row was opened whose root listing is not cached yet. */
  onLoadRoot(ref: string): void;
  /** Load a file-layer directory's next page (its trailing "加载更多" row). */
  onLoadMoreDir?(ref: string): void;
  /** The next roots page: in flight, or its refusal. */
  rootsMore?: { loading: boolean; refusal: string };
  /** Load the next roots page; absent means the index only says more exist. */
  onLoadMoreRoots?(): void;
  onOpenFile(link: ResourceLink, location?: ListedFileLocation): void;
  onEditFile?(link: ResourceLink, location?: ListedFileLocation): void;
  onNewSession(device: string, directory: string): void;
  onOpenTerminal(device: string): void;
}

/** Keep the reader's position when the optional file plane changes the index body. */
function usePreservedIndexScroll(): RefCallback<HTMLElement> {
  const mounted = useRef<HTMLElement | null>(null);
  const scrollTop = useRef(0);
  return useCallback((node) => {
    if (mounted.current && mounted.current !== node) scrollTop.current = mounted.current.scrollTop;
    mounted.current = node;
    if (node) node.scrollTop = scrollTop.current;
  }, []);
}

function AccessLine({ access, narrow }: { access: readonly WorkspaceAccessRow[]; narrow?: boolean }) {
  if (!access.length) return null;
  const chips = <div className="wsaccess" data-av-session-access>{accessChips(access)}</div>;
  if (!narrow) return chips;
  // `<details>` rather than a state flag: the browser owns the disclosure, so
  // it stays keyboard reachable and findable by in-page search without this
  // component holding one more piece of interaction state.
  return (
    <details className="wsaccess-fold" data-av-session-access>
      <summary>权限</summary>
      {chips}
    </details>
  );
}

function accessChips(access: readonly WorkspaceAccessRow[]) {
  return (
    <>
      {access.map((row, index) => {
        const word = row.effective
          ? row.alwaysApprove
            ? "每次批准"
            : row.autoAllow
              ? "免批"
              : "已授权"
          : "不可用";
        const tone = row.effective ? (row.alwaysApprove ? "ask" : row.autoAllow ? "auto" : "ok") : "off";
        return (
          <span className="wsaccess-chip" data-tone={tone} title={row.explanation ?? ""} key={row.operation ?? index}>
            {row.title || row.operation}:{word}
          </span>
        );
      })}
    </>
  );
}

/**
 * The manual re-list, on the viewports where it earns its row.
 *
 * The index already lists at mount and re-lists on every Runner wake, so this
 * button is a convenience for "I changed something outside the browser". On the
 * phone layer the rail is one screen and that convenience costs a full 44px
 * touch target beside the only heading — so it stands down there (ticket #181).
 * The refresh PATH is untouched: `onRefresh` still exists and the wide layout
 * still shows it.
 */
function RailRefresh({ props }: { props: DirectoryIndexProps }) {
  if (props.narrow) return null;
  return (
    <AvButton
      id={scopedDomId("railRefresh", props.domIdScope)}
      className="rail-refresh"
      data-av-session-action="refresh-index"
      aria-label="刷新工作区目录"
      title="刷新工作区目录"
      onClick={props.onRefresh}
    >
      ↻
    </AvButton>
  );
}

/** Offline session sources, for the sessions view's footer. */
export function SourcesStatus({ sources }: { sources?: readonly SourceRow[] }) {
  const offline = [...new Set((sources ?? [])
    .filter((source) => source.online === false)
    .map((source) => source.deviceLabel || source.device || "会话来源"))];
  if (!offline.length) return null;
  return (
    <div className="directory-index-status" role="status" aria-label="会话来源状态" tabIndex={0}>
      <p>{offline.join("、")} 离线，会话列表可能不是最新。</p>
    </div>
  );
}

/** Keep the same footer space through scans, failures and recovery. */
function DirectoryIndexStatus({ props }: { props: DirectoryIndexProps }) {
  const offline = [...new Set((props.sources ?? [])
    .filter((source) => source.online === false)
    .map((source) => source.deviceLabel || source.device || "会话来源"))];
  const refusal = props.showFiles && props.rootsStatus === "refused";
  return (
    <div className="directory-index-status" role="status" aria-label="目录索引异常"
      tabIndex={offline.length || refusal ? 0 : undefined}>
      {offline.length ? <p>{offline.join("、")} 离线，会话列表可能不是最新。</p> : null}
      {refusal ? <p data-av-file-refusal>{props.rootsMessage || "无法列出工作区。"}</p> : null}
    </div>
  );
}

function NewSessionPlus({
  device,
  dir,
  onNewSession,
}: {
  device: string;
  dir: string;
  onNewSession(device: string, directory: string): void;
}) {
  if (!isResolvableDir(dir)) return null;
  return (
    <button
      type="button"
      className="dirplus"
      title="在此目录新建 session"
      data-new-device={device}
      data-new-directory={dir}
      data-av-session-action="new-directory"
      onClick={(event) => {
        event.stopPropagation();
        onNewSession(device, dir);
      }}
    >
      ＋
    </button>
  );
}

function DeviceTerminalButton({
  device,
  onOpen,
}: {
  device: string;
  onOpen(device: string): void;
}) {
  return (
    <AvButton
      className="device-terminal-open"
      data-av-session-action="open-terminal"
      aria-label={`打开 ${device} 的远端终端`}
      title={`打开 ${device} 的远端终端`}
      onClick={() => onOpen(device)}
    >
      <span aria-hidden="true">›_</span>
    </AvButton>
  );
}

function IndexRowView({ row, props }: { row: IndexRow; props: DirectoryIndexProps }) {
  if (row.type === "device") {
    return (
      <>
        <div className={`devhead${row.scanRoot ? " readonly-source" : ""}`} data-av-device-row>
          <span className="treehead" data-tree={row.key} onClick={() => props.onToggle(row.key, row.open)}>
            <FileTreeChevron open={row.open} />
            <FileTreeGlyph kind="device" />
            <span className="wslabel">{props.workspacesByDevice[row.device]?.deviceLabel || props.sessions.find((session) => session.device === row.device && session.deviceId === row.device)?.deviceLabel || row.device}</span>
            {row.scanRoot ? <span className="wsmeta"> · 🗄 只读扫描源</span> : null}
            <span className="badge">{row.total}</span>
          </span>
          {!row.scanRoot ? (
            <DeviceTerminalButton device={row.device} onOpen={props.onOpenTerminal} />
          ) : null}
        </div>
        {row.open && !row.scanRoot ? <AccessLine access={props.access} narrow={props.narrow} /> : null}
      </>
    );
  }
  if (row.type === "directory") {
    return (
      <div className="dhead" data-av-directory-row style={{ paddingLeft: `${3 + row.depth * 12}px` }}>
        <span className="treehead" data-tree={row.key} onClick={() => toggleDirectory(row, props)}>
          <FileTreeChevron open={row.open} />
          <FileTreeGlyph kind="directory" expanded={row.open} />
          <span className="wslabel">{row.disp}</span>
          <span className="badge">{row.count}</span>
          {row.workspace ? <span className="wsmeta"> · {row.workspace.label}</span> : null}
          {row.filesNote ? <span className="wsmeta"> · {row.filesNote}</span> : null}
        </span>
        {!props.sharedOnly && <NewSessionPlus device={row.device} dir={row.dir} onNewSession={props.onNewSession} />}
      </div>
    );
  }
  if (row.type === "workspace") {
    const dir = row.row.display || "";
    return (
      <div className="dhead" data-av-directory-row style={{ paddingLeft: `${3 + row.depth * 12}px` }}>
        {row.rootRef ? (
          <AvButton
            className="wsdir"
            data-av-file-directory
            data-ref={row.rootRef}
            onClick={() => toggleWorkspace(row, props)}
          >
            <FileTreeChevron open={row.open} />
            <FileTreeGlyph kind="directory" expanded={row.open} />
            <span className="wslabel">{row.row.label}</span>
            {dir && dir !== row.row.label ? <span className="wsmeta"> · {dir}</span> : null}
          </AvButton>
        ) : (
          <span className="treehead">
            <FileTreeChevron open={null} />
            <FileTreeGlyph kind="directory" />
            <span className="wslabel">{dir || row.row.label}</span>
            {row.filesNote ? <span className="wsmeta"> · {row.filesNote}</span> : null}
          </span>
        )}
        {!props.sharedOnly && <NewSessionPlus device={row.device} dir={dir} onNewSession={props.onNewSession} />}
      </div>
    );
  }
  if (row.type === "files" || row.type === "loose-root") {
    const depth = row.type === "files" ? row.depth : row.row.depth;
    return (
      <ul className="wstree" data-av-file-tree role="tree">
        <FileTreeRow
          row={row.row}
          depth={depth}
          selected={props.selectedFile}
          onToggle={props.onToggleDir}
          onOpenFile={props.onOpenFile}
          {...(props.onEditFile ? { onEditFile: props.onEditFile } : {})}
          {...(props.onLoadMoreDir ? { onLoadMore: props.onLoadMoreDir } : {})}
        />
      </ul>
    );
  }
  if (row.type === "idle-note") {
    return (
      <div
        className="idle-more"
        data-tree={row.key}
        style={{ paddingLeft: `${3 + row.depth * 12}px` }}
        onClick={() => props.onToggle(row.key, row.open)}
      >
        {row.open
          ? `▲ 收起 ${row.hidden} 个久未活动的目录`
          : `▾ 还有 ${row.hidden} 个久未活动的目录(可能已不存在)`}
      </div>
    );
  }
  if (row.type === "files-note") {
    return (
      <div className="wsmeta" style={{ paddingLeft: `${3 + row.depth * 12}px` }}>
        {row.loading ? "载入中…" : null}
        {row.refusal ? <span className="wsrefusal" data-av-file-refusal>{row.refusal}</span> : null}
      </div>
    );
  }
  return (
    <SessionRow
      session={row.session}
      depth={row.depth}
      flat={false}
      selected={props.selected}
      pinned={props.pinned}
      onSelect={props.onSelect}
    />
  );
}

function toggleDirectory(row: Extract<IndexRow, { type: "directory" }>, props: DirectoryIndexProps): void {
  props.onToggle(row.key, row.open);
  // Opening a joined row makes its file layer visible; list it once, lazily.
  if (!row.open && row.rootRef && !props.cache.has(row.rootRef)) props.onLoadRoot(row.rootRef);
}

function toggleWorkspace(row: Extract<IndexRow, { type: "workspace" }>, props: DirectoryIndexProps): void {
  props.onToggle(row.key, row.open);
  if (!row.open && row.rootRef && !props.cache.has(row.rootRef)) props.onLoadRoot(row.rootRef);
}

const DirectorySessionsIndex = createContext<ReturnType<typeof createDirectorySessionsIndex> | null>(null);

export function DirectoryIndex(props: DirectoryIndexProps) {
  return <SessionFamilies {...props}>{(sessions) => <DirectoryIndexContent {...props} sessions={sessions} />}</SessionFamilies>;
}

function DirectoryIndexContent(props: DirectoryIndexProps) {
  const index = useMemo(() => createDirectorySessionsIndex(props.sessions, props.cache), [props.sessions, props.cache]);
  return <DirectorySessionsIndex.Provider value={index}><DirectoryIndexBody {...props} /></DirectorySessionsIndex.Provider>;
}

function DirectoryIndexBody(props: DirectoryIndexProps) {
  const indexScrollRef = usePreservedIndexScroll();
  if (props.showFiles) return <FileDirectoryIndex props={props} indexScrollRef={indexScrollRef} />;
  const rows = directoryIndexRows({
    sessions: props.sessions,
    workspacesByDevice: props.workspacesByDevice,
    roots: props.roots,
    rootsSettled: props.rootsStatus === "ready" || props.rootsStatus === "refused",
    cache: props.cache,
    expandedDirs: props.expandedDirs,
    expanded: props.expanded,
    showFiles: false,
  });
  return (
    <div className="rosterpane" data-av-session-roster aria-busy={props.refreshing || props.indexPending || undefined}>
      <div className="railhead">
        <h2>目录</h2>
        <HiddenEntriesToggle
          id={scopedDomId("railHidden", props.domIdScope)}
          hidden={props.hideDotEntries}
          onToggle={props.onToggleHidden}
        />
        <RailRefresh props={props} />
      </div>
      {props.narrow ? null : (
        <div className="source-note" data-av-session-source-note>
          按设备 / 目录列出会话。目录右侧 ＋ 会把该目录带进新建表单，🗄 是只读扫描源。
        </div>
      )}
      <div id={scopedDomId("dirList", props.domIdScope)}>
        <section className="wsfiles" data-av-file-tree ref={indexScrollRef}>
          {rows.length ? (
            rows.map((row, index) => <IndexRowView row={row} props={props} key={indexRowKey(row, index)} />)
          ) : (
            <div className="small">当前没有会话。</div>
          )}
        </section>
      </div>
      <DirectoryIndexStatus props={props} />
    </div>
  );
}

function FileDirectoryIndex({
  props,
  indexScrollRef,
}: {
  props: DirectoryIndexProps;
  indexScrollRef: RefCallback<HTMLElement>;
}) {
  const rows = homeDirectoryRows({
    roots: props.roots,
    devices: props.devices,
    workspacesByDevice: props.workspacesByDevice,
    cache: props.cache,
    expandedDirs: props.expandedDirs,
    expanded: props.expanded,
    hideDotEntries: props.hideDotEntries,
  });
  const treeRef = useRef<HTMLUListElement>(null);
  const revealRequestId = props.revealDirectory?.requestId;
  const revealRef = props.revealDirectory?.ref;
  useEffect(() => {
    if (!revealRef) return;
    const workspaceRoot = treeRef.current?.closest<HTMLElement>("[data-av-dock-workspace]");
    let observer: MutationObserver | null = null;
    let geometry: ResizeObserver | null = null;
    let completed = false;
    const focusAndScroll = (): void => {
      if (completed) return;
      if (
        workspaceRoot?.getAttribute("data-av-narrow") === "1"
        && workspaceRoot.getAttribute("data-av-dock-mobile-section") !== "navigation"
      ) return;
      const target = [...(treeRef.current?.querySelectorAll<HTMLButtonElement>(".wsdir[data-ref], .wsfile[data-ref]") ?? [])]
        .find((button) => button.dataset.ref === revealRef);
      // The tree owns overflow; its enclosing section only owns the split size.
      const scroller = treeRef.current;
      if (!target || !scroller) return;
      const targetRect = target.getBoundingClientRect();
      const scrollerRect = scroller.getBoundingClientRect();
      if (targetRect.height <= 0 || scrollerRect.height <= 0) return;
      // Native focus scrolling can walk every scrollable ancestor, including
      // the App frame and its embedder. Focus without scrolling, then move only
      // this index so the selected workspace row is visible at its top edge.
      target.focus({ preventScroll: true });
      // A phone layer can have geometry before Dock removes its inert flag.
      // Do not claim success until the row actually owns focus.
      if (document.activeElement !== target) return;
      const offset = targetRect.top - scrollerRect.top;
      scroller.scrollTop = Math.max(0, Math.round(scroller.scrollTop + offset));
      completed = true;
      observer?.disconnect();
      geometry?.disconnect();
    };
    // A successful reveal focuses the navigation panel. On a phone that focus
    // changes the shell's semantic layer in a later commit; measuring while the
    // panel is still hidden yields zero geometry. Observe that state boundary
    // instead of guessing how many timers the layout adapter needs.
    if (workspaceRoot) {
      observer = new MutationObserver(focusAndScroll);
      observer.observe(workspaceRoot, {
        attributes: true,
        subtree: true,
        attributeFilter: ["data-av-dock-mobile-section", "inert", "aria-hidden", "style"],
      });
    }
    const scroller = treeRef.current;
    if (scroller && typeof ResizeObserver !== "undefined") {
      geometry = new ResizeObserver(focusAndScroll);
      geometry.observe(scroller);
    }
    const timer = window.setTimeout(focusAndScroll, 0);
    return () => {
      window.clearTimeout(timer);
      observer?.disconnect();
      geometry?.disconnect();
    };
  }, [revealRef, revealRequestId]);
  return (
    <div className="rosterpane" data-av-session-roster aria-busy={props.refreshing || props.indexPending || undefined}>
      <div className="railhead">
        <HiddenEntriesToggle
          id={scopedDomId("railHidden", props.domIdScope)}
          hidden={props.hideDotEntries}
          onToggle={props.onToggleHidden}
        />
        <RailRefresh props={props} />
      </div>
      <div className="navigation-index-body" data-av-session-index>
        <section
          className="wsfiles"
          id={scopedDomId("list", props.domIdScope)}
          data-av-file-tree
          ref={indexScrollRef}
        >
          {props.rootsStatus === "ready" && !rows.length ? (
            <p className="wsmeta">这个账号还没有可浏览的工作区。</p>
          ) : null}
          {props.roots?.truncated ? (
            <MoreRoots
              {...(props.rootsMore ? { more: props.rootsMore } : {})}
              {...(props.onLoadMoreRoots ? { onLoadMore: props.onLoadMoreRoots } : {})}
            />
          ) : null}
          <ul ref={treeRef} className="wstree directory-file-tree" data-av-file-tree-rows role="tree">
            {rows.map((row) => (
              <HomeDirectoryRowView
                row={row}
                props={props}
                key={row.type === "files" ? row.row.key : row.key}
              />
            ))}
          </ul>
        </section>
      </div>
      <DirectoryIndexStatus props={props} />
    </div>
  );
}

function HomeDirectoryRowView({ row, props }: { row: HomeDirectoryRow; props: DirectoryIndexProps }) {
  if (row.type === "device") {
    // Ticket #201: the same row skeleton as everything below it — one chevron
    // column, one glyph column, one elided label — so the device header is the
    // top of the tree rather than a differently built line above it. It is
    // deliberately NOT `.wsdir`: that class is what a browser suite counts to
    // find real directory buttons, and a device is not one.
    return (
      <li className="wsrow home-device" data-av-device-row role="treeitem" aria-expanded={row.open} data-depth={0} aria-level={1}>
        <div className="wsrow-main">
          <button
            type="button"
            className="wsdevice treehead"
            data-av-device-heading
            data-tree={row.key}
            onClick={() => props.onToggle(row.key, row.open)}
          >
            <FileTreeChevron open={row.open} />
            <FileTreeGlyph kind="device" />
            <span className="wslabel">{row.label}</span>
            <span className="badge wsrow-detail">{row.total}</span>
          </button>
          {row.terminalDevice ? (
            <DeviceTerminalButton device={row.terminalDevice} onOpen={props.onOpenTerminal} />
          ) : (
            <AvButton className="device-terminal-open" disabled
              aria-label={`${row.label} 的终端不可用：当前会话设备列表未识别为 Runner`}
              title="当前会话设备列表未识别此来源为 Runner；请刷新设备列表。只读扫描源不支持终端。">
              <span aria-hidden="true">›_</span>
            </AvButton>
          )}
        </div>
      </li>
    );
  }
  if (row.type === "files") return <FileDirectoryRow row={row.row} launch={row.launch} props={props} />;
  if (row.root) return <FileDirectoryRow row={row.root} launch={row.launch} navigationRef={row.key} props={props} />;
  return (
    <li
      className="wsrow home-directory"
      data-av-directory-row
      role="treeitem"
      aria-expanded={row.open}
      style={{ paddingInlineStart: `${row.depth * 12}px` }}
    >
      <div className="wsrow-main">
        <AvButton className="wsdir" data-av-file-directory onClick={() => props.onToggle(row.key, row.open)}>
          <FileTreeChevron open={row.open} />
          <FileTreeGlyph kind={row.label === ".." ? "parent" : "directory"} expanded={row.open} />
          <span className="wslabel">{row.label}</span>
        </AvButton>
        <NavigationDirectoryActions
          row={null}
          navigationRef={row.key}
          label={row.label}
          launch={row.launch}
          props={props}
        />
      </div>
    </li>
  );
}

function FileDirectoryRow({
  row,
  launch,
  navigationRef,
  props,
}: {
  row: TreeRow;
  launch: DirectoryLaunchTarget | null;
  navigationRef?: string;
  props: DirectoryIndexProps;
}) {
  const directoryActions = row.kind === "directory" ? (
    <NavigationDirectoryActions
      row={row}
      navigationRef={navigationRef ?? row.ref ?? row.key}
      label={row.label}
      launch={launch}
      props={props}
    />
  ) : null;
  return (
    <FileTreeRow
      row={row}
      selected={props.selectedFile}
      onToggle={props.onToggleDir}
      onOpenFile={props.onOpenFile}
      {...(props.onEditFile ? { onEditFile: props.onEditFile } : {})}
      {...(props.onLoadMoreDir ? { onLoadMore: props.onLoadMoreDir } : {})}
      {...(directoryActions ? { directoryActions } : {})}
    />
  );
}

function NavigationDirectoryActions({
  row,
  navigationRef,
  label,
  launch,
  props,
}: {
  row: Pick<TreeRow, "ref" | "directoryKey"> | null;
  navigationRef: string;
  label: string;
  launch: DirectoryLaunchTarget | null;
  props: DirectoryIndexProps;
}) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const index = useContext(DirectorySessionsIndex)!;
  const matches = index.matches({ directory: row, display: launch });
  const target: SessionDirectoryTarget = {
    ref: row?.ref ?? navigationRef,
    label,
    ...(row?.directoryKey ? { directoryKey: row.directoryKey } : {}),
  };
  const active = props.sessionDirectory?.ref === target.ref;
  return matches.length > 0 || launch ? (
    <>
      {matches.length ? (
        <span ref={triggerRef} className="directory-sessions-anchor">
          <AvButton
            className="directory-sessions-trigger"
            data-av-session-action="directory-sessions"
            aria-label={`查看「${label}」子树下的 ${matches.length} 个会话`}
            aria-expanded={active}
            title="查看这个目录子树里的会话"
            onClick={() => active ? props.onCloseSessions() : props.onOpenSessions(target)}
          >
            <span aria-hidden="true">◉</span> {matches.length}
          </AvButton>
        </span>
      ) : null}
      {matches.length ? (
        <DirectorySessionsDialog
          open={active}
          directoryLabel={label}
          matches={matches}
          selected={props.selected}
          pinned={props.pinned}
          anchorRef={triggerRef}
          onClose={props.onCloseSessions}
          onSelect={props.onSelect}
        />
      ) : null}
      {launch && !props.sharedOnly ? (
        <NewSessionPlus device={launch.device} dir={launch.directory} onNewSession={props.onNewSession} />
      ) : null}
    </>
  ) : null;
}

function indexRowKey(row: IndexRow, index: number): string {
  if (row.type === "device") return row.key;
  if (row.type === "directory" || row.type === "workspace" || row.type === "idle-note") return row.key;
  if (row.type === "session") return `s:${row.session.resourceId}`;
  if (row.type === "files" || row.type === "loose-root") return `f:${row.row.key}`;
  return `n:${index}`;
}

/** Chats shared with this viewer (or by them); a guest sees only these. */
export function SharedSessionsIndex({ props }: { props: {
  sharedOnly?: boolean;
  sessions: readonly RosterSession[];
  sharedSessions?: import("@claude-bot/agent-sessions-contract").SharedSessionSummary[];
  onOpenShared?(shareId: string): Promise<import("@claude-bot/agent-sessions-contract").SessionsReply>;
  onSelect(resourceId: string): void;
} }) {
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  if (!props.sharedSessions?.length) return null;
  const open = async (id: string) => {
    if (props.sharedOnly && props.sessions[0]) { props.onSelect(props.sessions[0].resourceId); return; }
    const ownResource = props.sharedSessions?.find((s) => s.shareId === id)?.resourceId;
    if (ownResource) { props.onSelect(ownResource); return; }
    if (pending || !props.onOpenShared) return;
    setPending(id); setNotice("");
    try { const answer = await props.onOpenShared(id); if (!answer.ok) setNotice(answer.message); }
    catch { setNotice("共享会话打开失败，请重试"); }
    finally { setPending(null); }
  };
  return <section className="recent-index" aria-label="共享会话"><details open><summary>共享会话</summary><div className="recent-session-list">{props.sharedSessions.map((share) => <button className="sess" key={share.shareId} disabled={Boolean(pending) || share.revoked && !share.resourceId} onClick={() => void open(share.shareId)}>{share.title} · {share.tokensUsed.toLocaleString()} / {share.tokenLimit.toLocaleString()} tokens{share.revoked ? " · 已撤销" : ""}</button>)}</div>{notice ? <p role="status">{notice}</p> : null}</details></section>;
}
