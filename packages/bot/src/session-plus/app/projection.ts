/** Pure fold over App-owned state only. Runner resources are never copied here. */

/** Max annotations retained per file key. Consumers already cap on the wire. */
const ANNOTATIONS_PER_FILE_MAX = 128;
/** Folder bounds; the actions refuse past them and the fold re-applies them to old events. */
const FOLDERS_MAX = 64;
const FOLDER_NAME_MAX = 32;
const FILED_MAX = 2_000;
const FOLDER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SESSION_ID = /^[A-Za-z0-9_-]{1,1024}$/;

interface Folder { id: string; name: string; sessions: string[] }

function folderName(value: unknown): string {
  return Array.from(typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "").slice(0, FOLDER_NAME_MAX).join("");
}

function foldersFrom(value: unknown): Folder[] {
  const out: Folder[] = [];
  const filed = new Set<string>();
  for (const row of Array.isArray(value) ? value : []) {
    if (row === null || typeof row !== "object" || out.length >= FOLDERS_MAX) continue;
    const id = "id" in row && typeof row.id === "string" && FOLDER_ID.test(row.id) ? row.id : "";
    const name = folderName("name" in row ? row.name : "");
    if (!id || !name || out.some((folder) => folder.id === id)) continue;
    const sessions: string[] = [];
    for (const session of "sessions" in row && Array.isArray(row.sessions) ? row.sessions : []) {
      if (typeof session !== "string" || !SESSION_ID.test(session) || filed.has(session) || filed.size >= FILED_MAX) continue;
      filed.add(session);
      sessions.push(session);
    }
    out.push({ id, name, sessions });
  }
  return out;
}

/** Folder events, each total: a malformed or stale event changes nothing. */
function foldFolders(folders: Folder[], type: string, data: Record<string, unknown>): void {
  const id = typeof data.folder === "string" ? data.folder : "";
  if (type === "session_folder_saved") {
    const name = folderName(data.name);
    if (!FOLDER_ID.test(id) || !name) return;
    const existing = folders.find((folder) => folder.id === id);
    if (existing) existing.name = name;
    else if (folders.length < FOLDERS_MAX) folders.push({ id, name, sessions: [] });
    return;
  }
  if (type === "session_folder_deleted") {
    const index = folders.findIndex((folder) => folder.id === id);
    if (index >= 0) folders.splice(index, 1);
    return;
  }
  // sessions_filed: a chat lives in at most one folder; "" files it nowhere.
  const sessions = Array.isArray(data.sessions)
    ? [...new Set(data.sessions.filter((session): session is string => typeof session === "string" && SESSION_ID.test(session)))]
    : [];
  const target = id ? folders.find((folder) => folder.id === id) : undefined;
  if (!sessions.length || (id && !target)) return;
  const moving = new Set(sessions);
  for (const folder of folders) folder.sessions = folder.sessions.filter((session) => !moving.has(session));
  if (!target) return;
  const room = FILED_MAX - folders.reduce((total, folder) => total + folder.sessions.length, 0);
  target.sessions.push(...sessions.slice(0, Math.max(0, room)));
}

export function project(events: unknown[]) {
  return projectIncremental({}, events);
}

/** Fold a bounded tail onto the trusted no-viewer checkpoint. */
export function projectIncremental(snapshot: unknown, events: unknown[]) {
  const base = snapshot !== null && typeof snapshot === "object" && !Array.isArray(snapshot)
    ? snapshot as Record<string, unknown>
    : {};
  const pinned = Array.isArray(base.pinned) ? base.pinned.filter((value): value is string => typeof value === "string") : [];
  const customTitles = stringRecord(base.customTitles);
  const reviewedAt = stringRecord(base.reviewedAt);
  const sessionFolders = foldersFrom(base.sessionFolders);
  const fileAnnotations: Record<string, unknown[]> = {};
  if (base.fileAnnotations && typeof base.fileAnnotations === "object" && !Array.isArray(base.fileAnnotations)) {
    for (const [key, value] of Object.entries(base.fileAnnotations)) {
      if (Array.isArray(value)) fileAnnotations[key] = value.slice(0, ANNOTATIONS_PER_FILE_MAX);
    }
  }
  for (const event of Array.isArray(events) ? events : []) {
    if (event === null || typeof event !== "object" || !("data" in event) || event.data === null || typeof event.data !== "object") continue;
    if ("type" in event && event.type === "file_annotations_set") {
      const key = "file_key" in event.data && typeof event.data.file_key === "string" ? event.data.file_key : "";
      if (!key || key.length > 2048) continue;
      const list = "annotations" in event.data && Array.isArray(event.data.annotations) ? event.data.annotations.slice(0, ANNOTATIONS_PER_FILE_MAX) : [];
      if (list.length === 0) delete fileAnnotations[key];
      else fileAnnotations[key] = list;
      continue;
    }
    if ("type" in event && (event.type === "session_folder_saved" || event.type === "session_folder_deleted" || event.type === "sessions_filed")) {
      foldFolders(sessionFolders, event.type, event.data as Record<string, unknown>);
      continue;
    }
    const id = "session" in event.data && typeof event.data.session === "string" ? event.data.session : "";
    if (!/^[A-Za-z0-9_-]{1,1024}$/.test(id)) continue;
    if ("type" in event && event.type === "session_reviewed") {
      const completedAt = "completed_at" in event.data && typeof event.data.completed_at === "string"
        ? event.data.completed_at
        : "";
      const previous = reviewedAt[id];
      if (
        completedAt.length <= 64
        && Number.isFinite(Date.parse(completedAt))
        && (!previous || Date.parse(completedAt) > Date.parse(previous))
      ) reviewedAt[id] = completedAt;
      continue;
    }
    if ("type" in event && event.type === "session_pin_set") {
      const index = pinned.indexOf(id);
      if ("pinned" in event.data && event.data.pinned && index < 0) pinned.push(id);
      if ((!("pinned" in event.data) || !event.data.pinned) && index >= 0) pinned.splice(index, 1);
      continue;
    }
    if (!("type" in event) || event.type !== "session_title_set") continue;
    const title = Array.from("title" in event.data && typeof event.data.title === "string" ? event.data.title.replace(/\s+/gu, " ").trim() : "").slice(0, 48).join("");
    if (title) customTitles[id] = title;
    else delete customTitles[id];
  }
  return {
    notice: "真实会话内容按需来自 capability-backed source；收藏、文件夹、自定义标题、验收状态与文件批注留在 App 的独立持久状态中。",
    pinned,
    sessionFolders,
    customTitles,
    reviewedAt,
    fileAnnotations,
  };
}

function stringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [key, entry] of Object.entries(value)) if (typeof entry === "string") out[key] = entry;
  return out;
}
