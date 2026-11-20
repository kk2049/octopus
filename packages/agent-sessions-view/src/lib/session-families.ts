import { isForegroundTmuxSession, type RosterSession } from "./roster.js";

export interface SessionFamilyRoster {
  roots: RosterSession[];
  children: Map<string, RosterSession[]>;
}

/** Only opaque provider-declared parent identities establish a family. */
export function sessionFamilies(sessions: readonly RosterSession[], pinned: readonly string[] = []): SessionFamilyRoster {
  const byId = new Map(sessions.map((session) => [session.resourceId, session]));
  const roots: RosterSession[] = [];
  const children = new Map<string, RosterSession[]>();
  const visible = new Set(pinned);
  for (const session of byId.values()) {
    const parent = session.parentResourceId;
    const parentRow = parent ? byId.get(parent) : undefined;
    if (!parentRow || session.userNamed || visible.has(session.resourceId) || isForegroundTmuxSession(session)
      || parentRow.deviceId !== session.deviceId || parentRow.cliKind !== session.cliKind) {
      roots.push(session);
      continue;
    }
    // Cycles are uncertain lineage: show the real chats instead of inventing a parent.
    const seen = new Set([session.resourceId]);
    let ancestor: string | undefined = parent;
    while (ancestor && !seen.has(ancestor)) {
      seen.add(ancestor);
      ancestor = byId.get(ancestor)?.parentResourceId;
    }
    if (ancestor) {
      roots.push(session);
      continue;
    }
    const siblings = children.get(parentRow.resourceId) ?? [];
    siblings.push(session);
    children.set(parentRow.resourceId, siblings);
  }
  return { roots, children };
}
