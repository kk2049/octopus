/**
 * The session navigator's pure half: roster rows plus App-owned organisation
 * in, four sections out.
 *
 *   收藏    favorites, in the person's own pin order (never re-sorted by activity)
 *   文件夹  person-made folders, each sorted like 最近
 *   最近    everything else a person talks to
 *   自动化  provider-declared exec runs nobody filed, pinned or named
 *
 * A chat appears in exactly one of 最近 / 自动化 / one folder; a favorite also
 * stays visible inside its folder. Provider-declared children stay folded under
 * their parent wherever the parent is shown (`sessionFamilies`), unless the
 * person pinned, named or filed the child itself.
 *
 * Kept chats the roster does not carry (an offline device, an old Runner that
 * cannot answer an identity lookup) become `missing` items rather than
 * vanishing: absence from a frame is not deletion, and a favorite that silently
 * disappears is exactly the bug this navigator replaces.
 *
 * Nothing here fetches, sorts by transcript content or decides authority.
 */

import { isAutomatedSession, type SessionFolder, type SessionSummary } from "@claude-bot/agent-sessions-contract";
import { sessionFamilies, type SessionFamilyRoster } from "./session-families.js";
import { sortRecentSessions, type RosterSession } from "./roster.js";
import { titleOf } from "./projection.js";
import { sessionCliKindLabel } from "./cli.js";

export type NavigatorItem =
  | { kind: "session"; session: RosterSession }
  | { kind: "missing"; resourceId: string; title: string; cached?: SessionSummary };

export interface NavigatorFolder {
  folder: SessionFolder;
  items: NavigatorItem[];
  /** Chats inside that are running right now; shown on a collapsed folder. */
  live: number;
}

export interface NavigatorSections {
  favorites: NavigatorItem[];
  folders: NavigatorFolder[];
  recent: RosterSession[];
  automated: RosterSession[];
  families: SessionFamilyRoster;
  /** Every chat id in display order, for shift-click ranges. */
  order: string[];
}

export interface NavigatorInput {
  roster: readonly RosterSession[];
  pinned: readonly string[];
  folders: readonly SessionFolder[];
  customTitles?: Readonly<Record<string, string>>;
  /** Display-only fallback for kept chats outside this frame (search/history cache). */
  cached?: (resource: string) => SessionSummary | null;
  /** Case-insensitive substring over title, directory, device and provider. */
  filter?: string;
  isLive?: (session: RosterSession) => boolean;
}

export function navigatorSections(input: NavigatorInput): NavigatorSections {
  const filed = new Map<string, string>();
  for (const folder of input.folders) for (const id of folder.sessions) if (!filed.has(id)) filed.set(id, folder.id);
  const pinned = new Set(input.pinned);
  // Filing, like pinning or naming, keeps a child directly visible.
  const families = sessionFamilies(input.roster, [...input.pinned, ...filed.keys()]);
  const byId = new Map(input.roster.map((session) => [session.resourceId, session]));
  const needle = (input.filter ?? "").trim().toLowerCase();
  const familyMatches = (session: RosterSession): boolean => {
    if (!needle) return true;
    if (sessionMatches(session, needle)) return true;
    return (families.children.get(session.resourceId) ?? []).some(familyMatches);
  };
  const item = (resourceId: string, everything = false): NavigatorItem | null => {
    const session = byId.get(resourceId);
    if (session) return everything || familyMatches(session) ? { kind: "session", session } : null;
    const cached = input.cached?.(resourceId) ?? undefined;
    const title = input.customTitles?.[resourceId] || (cached ? titleOf(cached) : "");
    if (!everything && needle && !`${title} ${cached?.cwdDisplay ?? ""}`.toLowerCase().includes(needle)) return null;
    return { kind: "missing", resourceId, title, ...(cached ? { cached } : {}) };
  };

  const favorites = input.pinned.map((id) => item(id)).filter((row): row is NavigatorItem => row !== null);
  const folders = input.folders.map((folder) => {
    const folderHit = Boolean(needle) && folder.name.toLowerCase().includes(needle);
    const present = sortRecentSessions(folder.sessions.map((id) => byId.get(id)).filter((row): row is RosterSession =>
      Boolean(row) && (folderHit || familyMatches(row!))), Infinity);
    const missing = folder.sessions.filter((id) => !byId.has(id)).map((id) => item(id, folderHit))
      .filter((row): row is NavigatorItem => row !== null);
    const live = present.filter((session) => input.isLive?.(session)).length;
    return {
      folder,
      items: [...present.map((session): NavigatorItem => ({ kind: "session", session })), ...missing],
      live,
    };
  }).filter((folder) => !needle || folder.items.length > 0 || folder.folder.name.toLowerCase().includes(needle));

  const unfiled = families.roots.filter((session) =>
    !pinned.has(session.resourceId) && !filed.has(session.resourceId) && familyMatches(session));
  const recent: RosterSession[] = [];
  const automated: RosterSession[] = [];
  for (const session of sortRecentSessions(unfiled, Infinity)) {
    (isAutomatedSession(session) && !session.userNamed ? automated : recent).push(session);
  }

  const order: string[] = [];
  const seen = new Set<string>();
  const add = (id: string) => { if (!seen.has(id)) { seen.add(id); order.push(id); } };
  for (const row of favorites) add(row.kind === "session" ? row.session.resourceId : row.resourceId);
  for (const folder of folders) for (const row of folder.items) add(row.kind === "session" ? row.session.resourceId : row.resourceId);
  for (const session of [...recent, ...automated]) add(session.resourceId);
  return { favorites, folders, recent, automated, families, order };
}

/**
 * What the filter box searches: the row's own fields, never transcript bodies.
 * The untruncated title sources count, since the row shows a 48-character cut.
 */
export function sessionMatches(session: RosterSession, needle: string): boolean {
  if (!needle) return true;
  return [
    titleOf(session),
    session.title,
    session.firstUserText?.slice(0, 2_000),
    session.preview?.slice(0, 2_000),
    session.cwdDisplay,
    session.projectLabel,
    session.deviceLabel,
    session.deviceId,
    sessionCliKindLabel(session.cliKind, session.accountLabel),
  ].some((value) => typeof value === "string" && value.toLowerCase().includes(needle));
}

/** View-minted folder ids: opaque, unguessable enough to never collide in one account. */
export function newFolderId(random: () => number = Math.random): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "f_";
  for (let index = 0; index < 12; index += 1) id += alphabet[Math.floor(random() * alphabet.length)];
  return id;
}

/** The folder a chat currently lives in, if any. */
export function folderOfSession(folders: readonly SessionFolder[], resourceId: string): SessionFolder | null {
  return folders.find((folder) => folder.sessions.includes(resourceId)) ?? null;
}

/** Inclusive range between two ids in display order; unknown ids select just the target. */
export function selectionRange(order: readonly string[], anchor: string | null, target: string): string[] {
  const from = anchor ? order.indexOf(anchor) : -1;
  const to = order.indexOf(target);
  if (from < 0 || to < 0) return [target];
  const [start, end] = from <= to ? [from, to] : [to, from];
  return order.slice(start, end + 1);
}
