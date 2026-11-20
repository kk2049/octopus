import { createContext, useContext, useMemo, type ComponentProps, type ReactNode } from "react";
import { AvButton } from "@claude-bot/agent-view-react/ui";
import { sessionFamilies, type SessionFamilyRoster } from "../lib/session-families.js";
import type { RosterSession } from "../lib/roster.js";
import { titleOf } from "../lib/projection.js";
import { SessionRow } from "./SessionRow.js";

interface FamilyContext extends SessionFamilyRoster {
  expanded: Readonly<Record<string, boolean>>;
  onToggle(key: string, open: boolean): void;
}

const Families = createContext<FamilyContext | null>(null);

export function SessionFamilies({ sessions, pinned, expanded, onToggle, children }: {
  sessions: readonly RosterSession[];
  pinned?: readonly string[];
  expanded: Readonly<Record<string, boolean>>;
  onToggle(key: string, open: boolean): void;
  children(roots: readonly RosterSession[]): ReactNode;
}) {
  const roster = useMemo(() => sessionFamilies(sessions, pinned), [sessions, pinned]);
  return <SessionFamilyScope families={roster} expanded={expanded} onToggle={onToggle}>{children(roster.roots)}</SessionFamilyScope>;
}

/** For a caller that already derived the families (the navigator partitions them first). */
export function SessionFamilyScope({ families, expanded, onToggle, children }: {
  families: SessionFamilyRoster;
  expanded: Readonly<Record<string, boolean>>;
  onToggle(key: string, open: boolean): void;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ ...families, expanded, onToggle }), [families, expanded, onToggle]);
  return <Families.Provider value={value}>{children}</Families.Provider>;
}

/** The disclosure is a sibling of the open-chat button, so it never opens chat. */
export function SessionFamilyRow(props: ComponentProps<typeof SessionRow>) {
  const families = useContext(Families);
  const { session } = props;
  const children = families?.children.get(session.resourceId) ?? [];
  const label = "子 Agent";
  const key = `subagents:${session.resourceId}`;
  const open = families?.expanded[key] === true;
  return (
    <div className="session-family" data-av-session-family={session.resourceId}>
      <div className="session-family-card">
        <SessionRow {...props} />
        {children.length ? (
          <AvButton
            tone="quiet"
            className="session-subagents-toggle"
            data-av-session-subagents={session.resourceId}
            aria-label={`${titleOf(session)}的${label}（${children.length}）`}
            title={`${label}（${children.length}）`}
            aria-expanded={open}
            onClick={() => families?.onToggle(key, open)}
          >
            <span aria-hidden="true">{open ? "▾" : "▸"}</span> Sub
          </AvButton>
        ) : null}
      </div>
      {open && children.length ? (
        <div className="session-subagents" role="group" aria-label={`${titleOf(session)}的${label}`}>
          {children.map((child) => <SessionFamilyRow {...props} session={child} depth={0} key={child.resourceId} />)}
        </div>
      ) : null}
    </div>
  );
}
