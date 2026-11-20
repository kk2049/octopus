import { AvButton } from "@claude-bot/agent-view-react/ui";
/**
 * The session picker: a recent strip on top, a device → directory tree below.
 *
 * Two rules survive from the string renderer this replaced, because both were
 * learned the hard way:
 *
 *  · **"Recently active" is not "recently written to".** A long tool run stops
 *    appending to its log, so a `lastActivity`-only sort demotes a session
 *    exactly when it deserves the top slot. `sortRecentSessions` uses the
 *    activity derivation instead.
 *  · **The tree is strict `cwd`, and a chain of empty single-child directories
 *    collapses into one row.** Otherwise a project four levels down is four rows
 *    of nothing.
 *
 * The `＋` on a directory row carries THAT row's path into the new-agent form.
 * It appears wherever the displayed path is one a device could resolve — since
 * v4 a directory no longer has to have been registered first — and it is absent
 * where the roster showed `~/…/name`, because that ellipsis is a path this side
 * was deliberately not told. There is also a global entry above the tree: the
 * folder somebody just created has no row to hang a `＋` on, and that is exactly
 * the case this whole change exists for.
 *
 * It takes plain props. Nothing here reaches for a controller, a port or a
 * transport, which is what lets a read-only harness render the same rows from a
 * fixture.
 */

import type { WorkspaceGroup, WorkspaceRow } from "@claude-bot/agent-sessions-contract";
import {
  buildDirTree,
  isResolvableDir,
  sortRecentSessions,
  type DirNode,
  type RosterSession,
} from "../lib/roster.js";
import { SessionFamilies, SessionFamilyRow as SessionRow } from "./SessionFamilies.js";
export { SessionRow } from "./SessionRow.js";
import { scopedDomId } from "../lib/dom.js";

export interface SessionRosterProps {
  domIdScope?: string;
  sessions: readonly RosterSession[];
  pinned: readonly string[];
  selected: string | null;
  expanded: Readonly<Record<string, boolean>>;
  workspacesByDevice: Readonly<Record<string, WorkspaceGroup>>;
  onRefresh(): void;
  onSelect(resourceId: string): void;
  /** `open` is what the row is showing right now; the caller just flips it. */
  onToggle(key: string, open: boolean): void;
  onNewSession(device: string, directory: string): void;
}

function workspacesFor(map: Readonly<Record<string, WorkspaceGroup>>, device: string): WorkspaceRow[] {
  const value = map[device];
  return value && Array.isArray(value.workspaces) ? value.workspaces : [];
}

/**
 * The registered workspace that IS this directory, established by
 * `directoryKey` equality and by nothing else.
 *
 * This used to compare display strings, labels and basenames — a guess that
 * folded two directories into one row the day two projects were both called
 * `src`. The opaque key is the trusted side's own statement of sameness;
 * where either side carries none, the honest answer is "no match", and the
 * registered directory simply keeps its own row below the tree. Showing one
 * directory twice is better than folding two of them into one row.
 */
function matchingWorkspace(
  map: Readonly<Record<string, WorkspaceGroup>>,
  device: string,
  node: DirNode,
): WorkspaceRow | null {
  const key = node.sessions.find((session) => session.directoryKey)?.directoryKey;
  if (!key) return null;
  return workspacesFor(map, device).find((workspace) => workspace.directoryKey === key) ?? null;
}


function DirectoryNode({
  node,
  device,
  depth,
  used,
  props,
}: {
  node: DirNode;
  device: string;
  depth: number;
  used: Set<string>;
  props: SessionRosterProps;
}) {
  const open = props.expanded[node.key] === true;
  const workspace = matchingWorkspace(props.workspacesByDevice, device, node);
  if (workspace) used.add(workspace.id);
  return (
    <>
      <div className="dhead" data-av-directory-row style={{ paddingLeft: `${3 + depth * 12}px` }}>
        <span className="treehead" data-tree={node.key} onClick={() => props.onToggle(node.key, open)}>
          {open ? "▾" : "▸"} 📁 {node.disp} <span className="badge">{node.count}</span>
        </span>
        {/*
          The `＋` carries THIS row's directory into the form, and it appears for
          any row whose displayed path a device could actually resolve — not only
          for directories a background pass has already registered. A row showing
          `~/…/project` has no shortcut, because that `…` is a path this side was
          deliberately not told.
        */}
        {isResolvableDir(node.dir) ? (
          <AvButton
            className="dirplus"
            title="在此目录新建 session"
            data-new-device={device}
            data-new-directory={node.dir}
            onClick={(event) => {
              event.stopPropagation();
              props.onNewSession(device, node.dir);
            }}
          >
            ＋
          </AvButton>
        ) : null}
      </div>
      {open ? (
        <>
          {node.children.map((child) => (
            <DirectoryNode node={child} device={device} depth={depth + 1} used={used} props={props} key={child.key} />
          ))}
          {node.sessions.map((session) => (
            <SessionRow
              session={session}
              depth={depth + 1}
              flat={false}
              selected={props.selected}
              pinned={props.pinned}
              onSelect={props.onSelect}
              key={session.resourceId}
            />
          ))}
        </>
      ) : null}
    </>
  );
}

function ExtraWorkspaceRow({
  device,
  workspace,
  onNewSession,
}: {
  device: string;
  workspace: WorkspaceRow;
  onNewSession(device: string, directory: string): void;
}) {
  // The registry's display string IS the request: it is `~`-rooted or absolute,
  // in the same three shapes the device accepts. Where it is not — the `~/…/name`
  // form the Runner uses for a directory outside its scan root — the row shows
  // the directory and offers no shortcut, because a one-click start there would
  // be refused after the approval rather than before it.
  const dir = workspace.display || "";
  return (
    <div className="dhead" data-av-directory-row style={{ paddingLeft: "3px" }}>
      <span className="treehead">· 📁 {dir || workspace.label}</span>
      {isResolvableDir(dir) ? (
        <AvButton
          className="dirplus"
          title="在此目录新建 session"
          data-new-device={device}
          data-new-directory={dir}
          onClick={(event) => {
            event.stopPropagation();
            onNewSession(device, dir);
          }}
        >
          ＋
        </AvButton>
      ) : null}
    </div>
  );
}

function SessionList(props: SessionRosterProps) {
  const more = props.expanded["recent:more"] === true;
  const recent = sortRecentSessions(props.sessions, more ? 20 : 6, props.pinned);
  const groups = buildDirTree(props.sessions);
  const mapped = new Set(groups.map((group) => group.device));
  const orphanDevices = Object.keys(props.workspacesByDevice).filter((device) => !mapped.has(device));

  if (!recent.length && !groups.length && !orphanDevices.length) {
    return <div className="small">当前没有会话；正在读取已登记工作区。</div>;
  }

  return (
    <>
      {recent.length ? (
        <>
          <div className="recenthead" data-av-recent-sessions-heading>
            🕘 最近活跃 <span className="badge">{recent.length}</span>
          </div>
          {recent.map((session) => (
            <SessionRow
              session={session}
              depth={0}
              flat
              selected={props.selected}
              pinned={props.pinned}
              onSelect={props.onSelect}
              key={`recent:${session.resourceId}`}
            />
          ))}
          {Math.min(props.sessions.length, 20) > 6 ? (
            <div className="recent-more" id={scopedDomId("recentToggle", props.domIdScope)} onClick={() => props.onToggle("recent:more", more)}>
              {more ? "▲ 收起" : "▼ 显示更多"}
            </div>
          ) : null}
          <div className="sect-divider" />
        </>
      ) : null}

      {groups.map((group) => {
        const deviceKey = `dev:${group.device}`;
        // Devices start expanded: a collapsed-by-default tree hides the only
        // thing this rail is for.
        const open = props.expanded[deviceKey] ?? true;
        const used = new Set<string>();
        const children = group.children.map((child) => (
          <DirectoryNode node={child} device={group.device} depth={0} used={used} props={props} key={child.key} />
        ));
        const extras = workspacesFor(props.workspacesByDevice, group.device);
        return (
          <div key={deviceKey}>
            <div className={`devhead${group.device === "bot-host" ? " readonly-source" : ""}`} data-av-device-row>
              <span className="treehead" data-tree={deviceKey} onClick={() => props.onToggle(deviceKey, open)}>
                {open ? "▾ " : "▸ "}
                {group.device === "bot-host" ? "🗄 " : "💻 "}
                {props.workspacesByDevice[group.device]?.deviceLabel || props.sessions.find((row) => row.device === group.device && row.deviceId === group.device)?.deviceLabel || group.device} <span className="badge">{group.total}</span>
              </span>
            </div>
            {open ? (
              <>
                {children}
                {extras
                  .filter((workspace) => !used.has(workspace.id))
                  .map((workspace) => (
                    <ExtraWorkspaceRow
                      device={group.device}
                      workspace={workspace}
                      onNewSession={props.onNewSession}
                      key={workspace.id}
                    />
                  ))}
              </>
            ) : null}
          </div>
        );
      })}

      {orphanDevices.map((device) => (
        <div key={`orphan:${device}`}>
          <div className="devhead" data-av-device-row>
            <span className="treehead">▾ 💻 {props.workspacesByDevice[device]?.deviceLabel || device} <span className="badge">0</span></span>
          </div>
          {workspacesFor(props.workspacesByDevice, device).map((workspace) => (
            <ExtraWorkspaceRow
              device={device}
              workspace={workspace}
              onNewSession={props.onNewSession}
              key={workspace.id}
            />
          ))}
        </div>
      ))}
    </>
  );
}

export function SessionRoster(props: SessionRosterProps) {
  return <SessionFamilies {...props}>{(sessions) => <SessionRosterContent {...props} sessions={sessions} />}</SessionFamilies>;
}

function SessionRosterContent(props: SessionRosterProps) {
  return (
    <div className="rosterpane" data-av-session-roster>
      <div className="railhead">
        <h2>会话</h2>
        <AvButton id={scopedDomId("railRefresh", props.domIdScope)} onClick={props.onRefresh}>↻</AvButton>
      </div>
      {/*
        The global entry. It exists because the per-row `＋` can only offer
        directories something has already listed, and "start work in the folder I
        just made" is the case that matters most — the form is usable the moment
        the frame loads, before any workspace enumeration finishes.
      */}
      <AvButton
        id={scopedDomId("newAnywhere", props.domIdScope)}
        className="newanywhere"
        data-av-session-action="new-anywhere"
        onClick={() => props.onNewSession("", "")}
      >
        ＋ 在任意目录启动 Agent
      </AvButton>
      <div className="source-note" data-av-session-source-note>
        上方按最近活跃；下方按设备 / 目录。目录右侧 ＋ 会把该目录带进新建表单，🗄 是只读扫描源。
      </div>
      <div id={scopedDomId("list", props.domIdScope)} data-av-session-list>
        <SessionList {...props} />
      </div>
    </div>
  );
}
