import { useEffect, useRef } from "react";
import { tokenUsageLabel } from "@claude-bot/agent-sessions-contract";
import { isForegroundTmuxSession, type RosterSession } from "../lib/roster.js";
import { currentTurnState, titleOf } from "../lib/projection.js";
import { sessionCliKindLabel } from "../lib/cli.js";
import { activityStatus, formatTime, isBusy, shouldFollow } from "../lib/transcript.js";

/**
 * What the session navigator adds to a row. Optional as a whole: the directory
 * popover, the history dialog and the legacy roster render plain rows.
 */
export interface SessionRowNavigation {
  /** Multi-selection, separate from the one opened (`selected`) chat. */
  chosen: ReadonlySet<string>;
  draggable: boolean;
  /** The chat whose title is being edited in place. */
  renaming: string | null;
  onMenu(resourceId: string, anchor: HTMLElement): void;
  onRename(resourceId: string, title: string): void;
  onRenameCancel(): void;
}

export function SessionRow({
  session,
  depth,
  flat,
  selected,
  pinned,
  onSelect,
  navigation,
}: {
  session: RosterSession;
  depth: number;
  flat: boolean;
  selected: string | null;
  pinned: readonly string[];
  onSelect(resourceId: string): void;
  navigation?: SessionRowNavigation;
}) {
  const running = shouldFollow(session.activity) || currentTurnState(session.runtime) === "working";
  const tip = isBusy(session.activity) ? activityStatus(session.activity) : "Agent 正在运行";
  const activityTime = formatTime(session.sortActivity || session.lastActivity);
  // Keep the shared display timezone; only compact the list's full timestamp.
  const compactTime = activityTime.replace(/^\d{4}\/(\d{1,2}\/\d{1,2} \d{2}:\d{2}):\d{2}$/, "$1");
  const id = session.resourceId;
  const renaming = navigation?.renaming === id;
  const chosen = navigation?.chosen.has(id) ?? false;
  return (
    <div
      className={`sess${id === selected ? " on" : ""}${chosen ? " chosen" : ""}`}
      data-id={id}
      data-av-session-row={id}
      role="button"
      tabIndex={0}
      aria-selected={navigation ? chosen : undefined}
      draggable={navigation?.draggable && !renaming ? true : undefined}
      style={{ marginLeft: `${depth * 13}px` }}
      onClick={() => {
        if (!renaming) onSelect(id);
      }}
      onKeyDown={(event) => {
        if (renaming || event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(id);
        }
        if (navigation && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) {
          event.preventDefault();
          navigation.onMenu(id, event.currentTarget);
        }
      }}
    >
      <div className="t" data-av-session-title>
        <span className="activity-slot">
          {running ? (
            <span className="live-dot av-spin" data-av-session-live role="status" aria-label={tip || "Agent 正在运行"} title={tip || "Agent 正在运行"} />
          ) : session.needsReview ? (
            <span className="review-dot" role="status" aria-label="运行结果待验收" title="运行结果待验收" />
          ) : null}
        </span>
        {pinned.includes(id) ? (
          <span className="pin" data-av-session-pinned aria-label="已收藏">★</span>
        ) : null}
        {renaming && navigation ? (
          <InlineRename
            initial={titleOf(session)}
            label="会话名称"
            onCommit={(title) => navigation.onRename(id, title)}
            onCancel={navigation.onRenameCancel}
          />
        ) : <span className="session-title-text">{titleOf(session)}</span>}
        {navigation && !renaming ? (
          <button
            type="button"
            className="sess-menu"
            data-av-session-menu={id}
            aria-label={`${titleOf(session)} 的更多操作`}
            title="更多操作"
            onClick={(event) => {
              event.stopPropagation();
              navigation.onMenu(id, event.currentTarget);
            }}
          >
            <span aria-hidden="true">⋯</span>
          </button>
        ) : null}
      </div>
      <div className="m" data-av-session-meta>
        {flat ? `${session.deviceLabel || session.deviceId} · ` : ""}
        {sessionCliKindLabel(session.cliKind, session.accountLabel)} · {session.messageCount == null ? "条数未统计" : `${session.messageCount} 条`} · <span title={activityTime}>{compactTime}</span>
        {session.usage ? <span title="Codex 原生 token 统计；weekly 百分比无法可靠归因"> · {tokenUsageLabel(session.usage)}</span> : null}
        {isForegroundTmuxSession(session) ? <span data-av-session-tmux> · tmux</span> : null}
      </div>
    </div>
  );
}

/**
 * An in-place text edit: Enter or blur commits, Escape cancels. Keys never
 * reach the row underneath, which would otherwise open the chat on Enter, and
 * an IME composition's Enter only confirms the candidate.
 */
export function InlineRename({ initial, label, onCommit, onCancel }: {
  initial: string;
  label: string;
  onCommit(value: string): void;
  onCancel(): void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const settled = useRef(false);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const finish = (commit: boolean): void => {
    if (settled.current) return;
    settled.current = true;
    if (commit) onCommit(input.current?.value ?? "");
    else onCancel();
  };
  return (
    <input
      ref={input}
      className="nav-rename"
      aria-label={label}
      defaultValue={initial}
      maxLength={96}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Enter") {
          event.preventDefault();
          finish(true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          finish(false);
        }
      }}
      onBlur={() => finish(true)}
    />
  );
}
