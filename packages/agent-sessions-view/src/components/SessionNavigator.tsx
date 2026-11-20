/**
 * The sessions view of the navigator: favorites, person-made folders, recent
 * chats and provider-declared automated runs, with one filter box on top.
 *
 * Presentational and props-driven like the rest of this package: it derives
 * sections with `lib/navigator.ts`, renders rows through `SessionFamilyRow`, and
 * reports every organisation change through a callback that resolves to the
 * port's reply. Favorites and folders are App-owned state; nothing here
 * mutates a provider session, and a refusal is shown, never retried.
 *
 * Interaction model (VS Code explorer–like):
 *  · click opens; Ctrl/⌘-click toggles a multi-selection; Shift-click extends it;
 *  · drag one chat, or the selection, onto 收藏, a folder, the 文件夹 header (a
 *    new folder) or 最近 (out of every folder);
 *  · right-click, the ⋯ button or the context-menu key opens the same menu, so
 *    touch and keyboard users reach every action without dragging.
 */

import { useCallback, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { AvButton, AvInput } from "@claude-bot/agent-view-react/ui";
import { FileTreeChevron, FileTreeGlyph } from "@claude-bot/agent-workspace-files-view";
import type { SessionFolder, SessionSummary, SessionsReply } from "@claude-bot/agent-sessions-contract";
import {
  folderOfSession,
  navigatorSections,
  newFolderId,
  selectionRange,
  type NavigatorFolder,
  type NavigatorItem,
} from "../lib/navigator.js";
import type { RosterSession } from "../lib/roster.js";
import { currentTurnState, titleOf } from "../lib/projection.js";
import { sessionCliKindLabel } from "../lib/cli.js";
import { shouldFollow } from "../lib/transcript.js";
import { scopedDomId } from "../lib/dom.js";
import { SessionFamilyRow, SessionFamilyScope } from "./SessionFamilies.js";
import { InlineRename, type SessionRowNavigation } from "./SessionRow.js";
import { NavMenu, type NavMenuItem, type NavMenuState } from "./NavMenu.js";

/** Drag payload: a JSON array of opaque session resources. */
export const SESSION_DRAG_TYPE = "application/x-octopus-sessions";

export interface SessionNavigatorProps {
  domIdScope?: string;
  roster: readonly RosterSession[];
  pinned: readonly string[];
  folders: readonly SessionFolder[];
  customTitles?: Readonly<Record<string, string>>;
  selected: string | null;
  /** Section, folder and child-family disclosure, by key. Display state. */
  expanded: Readonly<Record<string, boolean>>;
  narrow?: boolean;
  /** The port can set favorites idempotently and keep folders. */
  organize: boolean;
  refreshing?: boolean;
  /** Footer status (offline sources and similar), owned by the caller. */
  status?: ReactNode;
  /** Opens the paged full-history browser. */
  historyControl?: ReactNode;
  /** Shared-session lists for a guest or an owner who shares. */
  shared?: ReactNode;
  /** A guest sees only what was shared: no organisation, no launches. */
  sharedOnly?: boolean;
  /** Display-only fallback for a kept chat outside the current frame. */
  sessionOf?(resource: string): SessionSummary | null;
  filter: string;
  onFilter(value: string): void;
  /** Enter in the filter: search every transcript for the same words. */
  onSearchAll(query: string): void;
  onSelect(resource: string): void;
  onToggle(key: string, open: boolean): void;
  onRefresh(): void;
  onNewSession(): void;
  onSetPinned(resources: readonly string[], pinned: boolean): Promise<SessionsReply>;
  onRename(resource: string, title: string): Promise<SessionsReply>;
  onSaveFolder(folder: string, name: string): Promise<SessionsReply>;
  onDeleteFolder(folder: string): Promise<SessionsReply>;
  onFile(resources: readonly string[], folder: string): Promise<SessionsReply>;
}

type MenuTarget =
  | { kind: "sessions"; ids: string[] }
  | { kind: "folder"; folder: SessionFolder };

const isLive = (session: RosterSession): boolean =>
  shouldFollow(session.activity) || currentTurnState(session.runtime) === "working";

function rowIdOf(target: EventTarget | null): string | null {
  const node = target instanceof Element ? target.closest<HTMLElement>("[data-av-session-row], [data-av-nav-missing]") : null;
  return node?.getAttribute("data-av-session-row") ?? node?.getAttribute("data-av-nav-missing") ?? null;
}

function zoneOf(target: EventTarget | null): string | null {
  return target instanceof Element ? target.closest<HTMLElement>("[data-nav-drop]")?.getAttribute("data-nav-drop") ?? null : null;
}

function draggedIds(event: DragEvent): string[] | null {
  try {
    const value = JSON.parse(event.dataTransfer.getData(SESSION_DRAG_TYPE)) as unknown;
    return Array.isArray(value) && value.every((id) => typeof id === "string") ? value as string[] : null;
  } catch {
    return null;
  }
}

export function SessionNavigator(props: SessionNavigatorProps) {
  const needle = props.filter.trim();
  const sections = useMemo(() => navigatorSections({
    roster: props.roster,
    pinned: props.pinned,
    folders: props.folders,
    ...(props.customTitles ? { customTitles: props.customTitles } : {}),
    ...(props.sessionOf ? { cached: props.sessionOf } : {}),
    filter: needle,
    isLive,
  }), [props.roster, props.pinned, props.folders, props.customTitles, props.sessionOf, needle]);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set());
  const anchor = useRef<string | null>(null);
  const [menu, setMenu] = useState<(NavMenuState & { target: MenuTarget; token: number }) | null>(null);
  const menuToken = useRef(0);
  const [renamingSession, setRenamingSession] = useState<string | null>(null);
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ ids: string[] } | null>(null);
  const [dropZone, setDropZone] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const organize = props.organize && !props.sharedOnly;
  const rootRef = useRef<HTMLDivElement>(null);

  const report = useCallback(async (work: Promise<SessionsReply>): Promise<boolean> => {
    try {
      const reply = await work;
      setNotice(reply.ok ? "" : reply.message || "操作被拒绝。");
      return reply.ok;
    } catch {
      setNotice("操作没有完成，请检查连接后重试。");
      return false;
    }
  }, []);

  const titleFor = (id: string): string => {
    const row = props.roster.find((session) => session.resourceId === id);
    return props.customTitles?.[id] || (row ? titleOf(row) : props.sessionOf?.(id) ? titleOf(props.sessionOf(id)!) : "会话");
  };

  const open = (id: string): void => {
    setChosen(new Set());
    props.onSelect(id);
  };

  const openMenu = (target: MenuTarget, x: number, y: number): void => {
    const items: NavMenuItem[] = [];
    let title = "";
    if (target.kind === "sessions") {
      const ids = target.ids;
      title = ids.length > 1 ? `已选 ${ids.length} 个会话` : titleFor(ids[0]!);
      if (ids.length === 1) items.push({ key: "open", label: "打开" });
      if (organize) {
        const allPinned = ids.every((id) => props.pinned.includes(id));
        items.push({ key: allPinned ? "unpin" : "pin", label: allPinned ? "取消收藏" : "收藏" });
        if (ids.length === 1) items.push({ key: "rename", label: "重命名" });
        items.push({
          key: "move",
          label: "移到文件夹",
          children: [
            ...props.folders.map((folder) => ({
              key: `file:${folder.id}`,
              label: folder.name,
              disabled: ids.every((id) => folder.sessions.includes(id)),
            })),
            { key: "file-new", label: "新建文件夹…" },
          ],
        });
        if (ids.some((id) => folderOfSession(props.folders, id))) items.push({ key: "unfile", label: "移出文件夹" });
      }
    } else {
      title = target.folder.name;
      items.push({ key: "folder-rename", label: "重命名文件夹" });
      items.push({ key: "folder-delete", label: "删除文件夹（会话回到最近）", danger: true });
    }
    menuToken.current += 1;
    setMenu({ x, y, title, items, target, token: menuToken.current });
  };

  const selectionFor = (id: string): string[] => chosen.has(id) && chosen.size > 1 ? [...chosen] : [id];

  const navigation: SessionRowNavigation = {
    chosen,
    draggable: organize && !props.narrow,
    renaming: renamingSession,
    onMenu(id, anchorNode) {
      const box = anchorNode.getBoundingClientRect();
      openMenu({ kind: "sessions", ids: selectionFor(id) }, box.left, box.bottom + 2);
    },
    onRename(id, title) {
      setRenamingSession(null);
      const next = title.replace(/\s+/gu, " ").trim();
      if (next !== (props.customTitles?.[id] ?? "") && next !== titleFor(id)) void report(props.onRename(id, next));
    },
    onRenameCancel: () => setRenamingSession(null),
  };

  const run = (key: string): void => {
    const target = menu?.target;
    if (!target) return;
    if (target.kind === "folder") {
      if (key === "folder-rename") setRenamingFolder(target.folder.id);
      if (key === "folder-delete") void report(props.onDeleteFolder(target.folder.id));
      return;
    }
    const ids = target.ids;
    if (key === "open") open(ids[0]!);
    else if (key === "pin" || key === "unpin") void report(props.onSetPinned(ids, key === "pin"));
    else if (key === "rename") setRenamingSession(ids[0]!);
    else if (key === "unfile") void report(props.onFile(ids, ""));
    else if (key === "file-new") setCreating({ ids });
    else if (key.startsWith("file:")) void report(props.onFile(ids, key.slice(5)));
    setChosen(new Set());
  };

  const dropInto = (zone: string, ids: string[]): void => {
    if (!ids.length) return;
    if (zone === "favorites") {
      const unpinned = ids.filter((id) => !props.pinned.includes(id));
      if (unpinned.length) void report(props.onSetPinned(unpinned, true));
    }
    else if (zone === "recent") void report(props.onFile(ids, ""));
    else if (zone === "new-folder") setCreating({ ids });
    else if (zone.startsWith("folder:")) void report(props.onFile(ids, zone.slice(7)));
    setChosen(new Set());
  };

  const createFolder = async (name: string): Promise<void> => {
    const pending = creating;
    setCreating(null);
    const trimmed = name.replace(/\s+/gu, " ").trim();
    if (!trimmed || !pending) return;
    const id = newFolderId();
    if (!(await report(props.onSaveFolder(id, trimmed)))) return;
    if (pending.ids.length) await report(props.onFile(pending.ids, id));
  };

  const shown = (key: string, fallback: boolean): boolean => Boolean(needle) || (props.expanded[key] ?? fallback);
  const toggle = (key: string, fallback: boolean): void => {
    if (!needle) props.onToggle(key, props.expanded[key] ?? fallback);
  };

  const sessionRow = (session: RosterSession, zone: string) => (
    <SessionFamilyRow
      key={`${zone}:${session.resourceId}`}
      session={session}
      depth={0}
      flat
      selected={props.selected}
      pinned={props.pinned}
      onSelect={open}
      {...(organize ? { navigation } : {})}
    />
  );

  const itemRow = (item: NavigatorItem, zone: string) => item.kind === "session"
    ? sessionRow(item.session, zone)
    : <MissingRow key={`${zone}:${item.resourceId}`} item={item} pinned={props.pinned.includes(item.resourceId)}
      chosen={chosen.has(item.resourceId)} onOpen={open}
      onMenu={organize ? (id, node) => navigation.onMenu(id, node) : undefined} />;

  const dragProps = organize ? {
    onDragStart: (event: DragEvent<HTMLDivElement>) => {
      const id = rowIdOf(event.target);
      if (!id) return;
      const ids = selectionFor(id);
      // Only the private type: a plain-text copy would drop titles into the composer.
      event.dataTransfer.setData(SESSION_DRAG_TYPE, JSON.stringify(ids));
      event.dataTransfer.effectAllowed = "move";
    },
    onDragOver: (event: DragEvent<HTMLDivElement>) => {
      const zone = zoneOf(event.target);
      if (!zone || !event.dataTransfer.types.includes(SESSION_DRAG_TYPE)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      if (zone !== dropZone) setDropZone(zone);
    },
    onDragLeave: (event: DragEvent<HTMLDivElement>) => {
      if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDropZone(null);
    },
    onDrop: (event: DragEvent<HTMLDivElement>) => {
      const zone = zoneOf(event.target);
      const ids = draggedIds(event);
      setDropZone(null);
      if (!zone || !ids) return;
      event.preventDefault();
      dropInto(zone, ids);
    },
    onDragEnd: () => setDropZone(null),
  } : {};

  const empty = !sections.favorites.length && !sections.folders.length && !sections.recent.length && !sections.automated.length;
  return (
    <div
      ref={rootRef}
      className="session-navigator"
      data-av-session-navigator
      data-av-session-roster
      aria-busy={props.refreshing || undefined}
      onKeyDown={(event) => {
        if (event.key === "Escape" && chosen.size) setChosen(new Set());
      }}
      onClickCapture={(event) => {
        const id = rowIdOf(event.target);
        if (!id || !organize) return;
        if (event.ctrlKey || event.metaKey || event.shiftKey) {
          event.preventDefault();
          event.stopPropagation();
          if (event.shiftKey) setChosen(new Set(selectionRange(sections.order, anchor.current, id)));
          else {
            setChosen((previous) => {
              const next = new Set(previous);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            });
            anchor.current = id;
          }
        } else if (!(event.target instanceof Element && event.target.closest(".sess-menu"))) anchor.current = id;
      }}
      onContextMenu={(event) => {
        const id = rowIdOf(event.target);
        if (!id || !organize || event.target instanceof HTMLInputElement) return;
        event.preventDefault();
        openMenu({ kind: "sessions", ids: selectionFor(id) }, event.clientX, event.clientY);
      }}
      {...dragProps}
    >
      <div className="nav-head">
        <h2 className="nav-title">会话</h2>
        {!props.sharedOnly ? (
          <div className="nav-actions">
            <AvButton tone="quiet" id={scopedDomId("newAnywhere", props.domIdScope)} className="nav-action"
              data-av-session-action="new-anywhere" aria-label="在任意目录启动 Agent" title="在任意目录启动 Agent"
              onClick={props.onNewSession}>
              <PlusGlyph />
            </AvButton>
            {organize ? (
              <AvButton tone="quiet" className="nav-action" data-av-session-action="new-folder"
                aria-label="新建文件夹" title="新建文件夹" onClick={() => setCreating({ ids: [] })}>
                <FolderPlusGlyph />
              </AvButton>
            ) : null}
            <AvButton tone="quiet" id={scopedDomId("navRefresh", props.domIdScope)} className="nav-action"
              data-av-session-action="refresh-sessions" aria-label="刷新会话列表" title="刷新会话列表" onClick={props.onRefresh}>
              <RefreshGlyph />
            </AvButton>
            {props.historyControl}
          </div>
        ) : null}
      </div>
      {!props.sharedOnly ? (
        <div className="nav-filter">
          <AvInput
            id={scopedDomId("navFilter", props.domIdScope)}
            type="search"
            value={props.filter}
            placeholder="筛选会话 · 回车搜索全文"
            aria-label="筛选会话"
            allowClear={{ clearIcon: <span role="img" aria-label="清空筛选">✕</span> }}
            onChange={(event) => props.onFilter(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter" && needle) {
                event.preventDefault();
                props.onSearchAll(needle);
              } else if (event.key === "Escape" && props.filter) {
                event.preventDefault();
                props.onFilter("");
              }
            }}
          />
        </div>
      ) : null}
      {chosen.size > 0 && organize ? (
        <div className="nav-selection" role="toolbar" aria-label="已选会话操作" data-av-nav-selection>
          <span>已选 {chosen.size} 个</span>
          <button type="button" onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            openMenu({ kind: "sessions", ids: [...chosen] }, box.left, box.bottom + 2);
          }}>操作…</button>
          <button type="button" onClick={() => setChosen(new Set())}>取消选择</button>
        </div>
      ) : null}
      {notice ? <p className="nav-notice" role="status" data-av-nav-notice>{notice}</p> : null}
      <div className="nav-scroll" data-av-session-list>
        {props.shared}
        {props.sharedOnly ? null : (
          <SessionFamilyScope families={sections.families} expanded={props.expanded} onToggle={props.onToggle}>
            {/* While filtering, sections without a match step aside. */}
            {!needle || sections.favorites.length ? <NavSection
              id="favorites" title="收藏" glyph="★" count={sections.favorites.length}
              open={shown("nav:favorites", true)} onToggle={() => toggle("nav:favorites", true)}
              zone={organize ? "favorites" : undefined} dropActive={dropZone === "favorites"}
            >
              {sections.favorites.map((item) => itemRow(item, "fav"))}
              {!sections.favorites.length && !needle ? (
                <p className="nav-empty">{organize ? "把会话拖到这里，或在 ⋯ 菜单里收藏。" : "还没有收藏的会话。"}</p>
              ) : null}
            </NavSection> : null}
            {organize && (!needle || sections.folders.length) ? (
              <NavSection
                id="folders" title="文件夹" count={sections.folders.length}
                open={shown("nav:folders", true)} onToggle={() => toggle("nav:folders", true)}
                zone="new-folder" dropActive={dropZone === "new-folder"}
              >
                {creating ? (
                  <div className="nav-folder-head creating">
                    <FileTreeChevron open={null} />
                    <FileTreeGlyph kind="directory" />
                    <InlineRename initial="" label="新文件夹名称" onCommit={(name) => void createFolder(name)} onCancel={() => setCreating(null)} />
                    {creating.ids.length ? <span className="badge">{creating.ids.length}</span> : null}
                  </div>
                ) : null}
                {sections.folders.map((entry) => (
                  <NavFolderView
                    key={entry.folder.id}
                    entry={entry}
                    open={shown(`folder:${entry.folder.id}`, false)}
                    renaming={renamingFolder === entry.folder.id}
                    dropActive={dropZone === `folder:${entry.folder.id}`}
                    onToggle={() => toggle(`folder:${entry.folder.id}`, false)}
                    onMenu={(x, y) => openMenu({ kind: "folder", folder: entry.folder }, x, y)}
                    onRename={(name) => {
                      setRenamingFolder(null);
                      const next = name.replace(/\s+/gu, " ").trim();
                      if (next && next !== entry.folder.name) void report(props.onSaveFolder(entry.folder.id, next));
                    }}
                    onRenameCancel={() => setRenamingFolder(null)}
                  >
                    {entry.items.map((item) => itemRow(item, entry.folder.id))}
                  </NavFolderView>
                ))}
                {!sections.folders.length && !creating && !needle ? (
                  <p className="nav-empty">新建文件夹，再把相关会话拖进去（可多选）。</p>
                ) : null}
              </NavSection>
            ) : null}
            {!needle || sections.recent.length ? <NavSection
              id="recent" title="最近会话" count={sections.recent.length}
              open={shown("nav:recent", true)} onToggle={() => toggle("nav:recent", true)}
              zone={organize ? "recent" : undefined} dropActive={dropZone === "recent"}
            >
              {sections.recent.map((session) => sessionRow(session, "recent"))}
            </NavSection> : null}
            {sections.automated.length ? (
              <NavSection
                id="automated" title="自动化任务" count={sections.automated.length}
                open={shown("nav:automated", false)} onToggle={() => toggle("nav:automated", false)}
                zone={organize ? "recent" : undefined} dropActive={false}
              >
                <p className="nav-hint">Codex 标记为非交互运行（codex exec）的会话。收藏、命名或放进文件夹后会移出这里。</p>
                {sections.automated.map((session) => sessionRow(session, "auto"))}
              </NavSection>
            ) : null}
            {empty ? (
              <p className="nav-empty">{needle ? "没有匹配的会话。按回车在全部会话正文中搜索。" : "当前没有会话。"}</p>
            ) : null}
          </SessionFamilyScope>
        )}
      </div>
      {props.status}
      {menu ? (
        <NavMenu key={menu.token} menu={menu} onSelect={run} onClose={() => setMenu(null)}
          host={rootRef.current?.closest<HTMLElement>("[data-app-surface]") ?? null} />
      ) : null}
    </div>
  );
}

function NavSection({ id, title, glyph, count, open, onToggle, zone, dropActive, children }: {
  id: string;
  title: string;
  glyph?: string;
  count: number;
  open: boolean;
  onToggle(): void;
  zone?: string;
  dropActive: boolean;
  children: ReactNode;
}) {
  return (
    <section
      className={`nav-section${dropActive ? " drop" : ""}`}
      data-av-nav-section={id}
      data-nav-drop={zone}
      aria-label={title}
    >
      <div className="nav-section-head">
        <button type="button" className="nav-section-toggle" aria-expanded={open} onClick={onToggle}>
          <FileTreeChevron open={open} />
          {glyph ? <span className="nav-section-glyph" aria-hidden="true">{glyph}</span> : null}
          <span className="nav-section-title">{title}</span>
          <span className="badge">{count}</span>
        </button>
      </div>
      {open ? <div className="nav-section-body">{children}</div> : null}
    </section>
  );
}

function NavFolderView({ entry, open, renaming, dropActive, onToggle, onMenu, onRename, onRenameCancel, children }: {
  entry: NavigatorFolder;
  open: boolean;
  renaming: boolean;
  dropActive: boolean;
  onToggle(): void;
  onMenu(x: number, y: number): void;
  onRename(name: string): void;
  onRenameCancel(): void;
  children: ReactNode;
}) {
  const { folder, items, live } = entry;
  return (
    <div className={`nav-folder${dropActive ? " drop" : ""}`} data-nav-drop={`folder:${folder.id}`} data-av-nav-folder={folder.id}>
      <div
        className="nav-folder-head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-label={`文件夹 ${folder.name}，${items.length} 个会话`}
        onClick={() => { if (!renaming) onToggle(); }}
        onKeyDown={(event) => {
          if (renaming || event.target !== event.currentTarget) return;
          if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onToggle(); }
          if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
            event.preventDefault();
            const box = event.currentTarget.getBoundingClientRect();
            onMenu(box.left + 24, box.bottom + 2);
          }
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onMenu(event.clientX, event.clientY);
        }}
      >
        <FileTreeChevron open={open} />
        <FileTreeGlyph kind="directory" expanded={open} />
        {renaming ? (
          <InlineRename initial={folder.name} label="文件夹名称" onCommit={onRename} onCancel={onRenameCancel} />
        ) : <span className="nav-folder-name">{folder.name}</span>}
        {live ? <span className="live-dot av-spin" role="status" aria-label={`${live} 个会话正在运行`} title={`${live} 个会话正在运行`} /> : null}
        <span className="badge">{items.length}</span>
        {!renaming ? (
          <button type="button" className="sess-menu" aria-label={`${folder.name} 文件夹的更多操作`} title="更多操作"
            onClick={(event) => {
              event.stopPropagation();
              const box = event.currentTarget.getBoundingClientRect();
              onMenu(box.left, box.bottom + 2);
            }}>
            <span aria-hidden="true">⋯</span>
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="nav-folder-items">
          {children}
          {!items.length ? <p className="nav-empty">把会话拖到这个文件夹。</p> : null}
        </div>
      ) : null}
    </div>
  );
}

/** A kept chat this frame does not carry: shown honestly instead of vanishing. */
function MissingRow({ item, pinned, chosen, onOpen, onMenu }: {
  item: Extract<NavigatorItem, { kind: "missing" }>;
  pinned: boolean;
  chosen: boolean;
  onOpen(resource: string): void;
  onMenu?: (resource: string, anchor: HTMLElement) => void;
}) {
  const cached = item.cached;
  const meta = cached
    ? `${cached.deviceLabel || cached.deviceId || ""} · ${sessionCliKindLabel(cached.cliKind, cached.accountLabel)} · 不在当前名册`
    : "不在当前名册：设备离线、Runner 待升级或会话已删除";
  return (
    <div
      className={`sess missing${chosen ? " chosen" : ""}`}
      data-av-nav-missing={item.resourceId}
      role="button"
      tabIndex={0}
      onClick={() => onOpen(item.resourceId)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(item.resourceId); }
      }}
    >
      <div className="t">
        <span className="activity-slot" />
        {pinned ? <span className="pin" aria-label="已收藏">★</span> : null}
        <span className="session-title-text">{item.title || "不在名册中的会话"}</span>
        {onMenu ? (
          <button type="button" className="sess-menu" aria-label={`${item.title || "不在名册中的会话"} 的更多操作`} title="更多操作"
            onClick={(event) => { event.stopPropagation(); onMenu(item.resourceId, event.currentTarget); }}>
            <span aria-hidden="true">⋯</span>
          </button>
        ) : null}
      </div>
      <div className="m">{meta}</div>
    </div>
  );
}

function FolderPlusGlyph() {
  return (
    <svg className="nav-glyph" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <path d="M1.5 3.5h4l1.5 1.5h7.5v8.5h-13z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M8 7.5v4M6 9.5h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function PlusGlyph() {
  return (
    <svg className="nav-glyph" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <path d="M8 2.5v11M2.5 8h11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function RefreshGlyph() {
  return (
    <svg className="nav-glyph" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <path d="M13.5 8A5.5 5.5 0 1 1 11.9 4.1M13.5 2.5v3h-3" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
