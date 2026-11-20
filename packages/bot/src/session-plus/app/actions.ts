/** Session Plus private logic stays intentionally thin: event-producing App-state actions. */

function sessionOf(parameters: unknown, action: string): string {
  const session = parameters !== null && typeof parameters === "object" && "session" in parameters && typeof parameters.session === "string" ? parameters.session : "";
  if (!/^[A-Za-z0-9_-]{1,1024}$/.test(session)) throw new Error(`${action} requires an opaque session resource id`);
  return session;
}

function answer(context: unknown, type: string, data: Record<string, unknown>, result = data) {
  return {
    events: [{ type, data, at: String(context !== null && typeof context === "object" && "now" in context ? context.now ?? "" : ""), by: "session-plus" }],
    result,
  };
}

function stateOf(context: unknown): Record<string, unknown> {
  return context !== null && typeof context === "object" && "state" in context && context.state !== null && typeof context.state === "object"
    ? context.state as Record<string, unknown>
    : {};
}

function param(parameters: unknown, key: string): string {
  return parameters !== null && typeof parameters === "object" && key in parameters && typeof (parameters as Record<string, unknown>)[key] === "string"
    ? (parameters as Record<string, string>)[key]!
    : "";
}

/** `pinned` makes a drop onto favorites idempotent; without it the action still toggles. */
export function pin_session(context: unknown, parameters: unknown) {
  const session = sessionOf(parameters, "pin_session");
  const state = stateOf(context);
  const pinned = Array.isArray(state.pinned) ? state.pinned : [];
  const wanted = param(parameters, "pinned");
  const next = wanted === "true" ? true : wanted === "false" ? false : !pinned.includes(session);
  return answer(context, "session_pin_set", { session, pinned: next }, { session });
}

/** Bounds shared with the projection fold, which re-applies them to every event. */
export const SESSION_FOLDERS_MAX = 64;
export const SESSION_FOLDER_NAME_MAX = 32;
export const SESSION_FILED_MAX = 2_000;
const FILE_BATCH_MAX = 64;

function folderIdOf(parameters: unknown, action: string): string {
  const folder = param(parameters, "folder");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(folder)) throw new Error(`${action} requires an opaque folder id`);
  return folder;
}

function foldersOf(context: unknown): Array<{ id: string; sessions: string[] }> {
  const value = stateOf(context).sessionFolders;
  return Array.isArray(value) ? value.filter((folder): folder is { id: string; sessions: string[] } =>
    folder !== null && typeof folder === "object" && typeof folder.id === "string" && Array.isArray(folder.sessions)) : [];
}

/** Create or rename one folder. The View mints the id, so a retry cannot fork a second folder. */
export function save_session_folder(context: unknown, parameters: unknown) {
  const folder = folderIdOf(parameters, "save_session_folder");
  const name = param(parameters, "name").replace(/\s+/gu, " ").trim();
  if (!name) throw new Error("文件夹名称不能为空");
  if (Array.from(name).length > SESSION_FOLDER_NAME_MAX) throw new Error(`文件夹名称最多 ${SESSION_FOLDER_NAME_MAX} 个字符`);
  const folders = foldersOf(context);
  if (!folders.some((row) => row.id === folder) && folders.length >= SESSION_FOLDERS_MAX) {
    throw new Error(`最多 ${SESSION_FOLDERS_MAX} 个文件夹`);
  }
  return answer(context, "session_folder_saved", { folder, name });
}

/** Deleting a folder only returns its chats to the unfiled list. */
export function delete_session_folder(context: unknown, parameters: unknown) {
  const folder = folderIdOf(parameters, "delete_session_folder");
  return answer(context, "session_folder_deleted", { folder });
}

/** Move chats into one folder (each chat is in at most one), or out of all of them. */
export function file_sessions(context: unknown, parameters: unknown) {
  const sessions = [...new Set(param(parameters, "sessions").split(",").filter(Boolean))];
  if (!sessions.length || sessions.length > FILE_BATCH_MAX || sessions.some((id) => !/^[A-Za-z0-9_-]{1,1024}$/.test(id))) {
    throw new Error(`file_sessions requires 1–${FILE_BATCH_MAX} opaque session resource ids`);
  }
  const folder = param(parameters, "folder") === "" ? "" : folderIdOf(parameters, "file_sessions");
  const folders = foldersOf(context);
  if (folder && !folders.some((row) => row.id === folder)) throw new Error("文件夹不存在或已删除");
  const moving = new Set(sessions);
  const remaining = folders.reduce((total, row) => total + row.sessions.filter((id) => !moving.has(id)).length, 0);
  if (folder && remaining + sessions.length > SESSION_FILED_MAX) throw new Error(`文件夹里最多放 ${SESSION_FILED_MAX} 个会话`);
  return answer(context, "sessions_filed", { folder, sessions });
}

export function set_session_title(context: unknown, parameters: unknown) {
  const session = sessionOf(parameters, "set_session_title");
  const title = parameters !== null && typeof parameters === "object" && "title" in parameters && typeof parameters.title === "string" ? parameters.title.replace(/\s+/gu, " ").trim() : "";
  if (Array.from(title).length > 48) throw new Error("会话标题最多 48 个字符");
  return answer(context, "session_title_set", { session, title });
}

export function review_session(context: unknown, parameters: unknown) {
  const session = sessionOf(parameters, "review_session");
  const completedAt = parameters !== null
    && typeof parameters === "object"
    && "completed_at" in parameters
    && typeof parameters.completed_at === "string"
    ? parameters.completed_at
    : "";
  if (completedAt.length > 64 || !Number.isFinite(Date.parse(completedAt))) {
    throw new Error("review_session requires a valid completed_at timestamp");
  }
  return answer(context, "session_reviewed", { session, completed_at: completedAt });
}

/** Max annotations retained per file key. Also enforced view-side. */
const ANNOTATIONS_PER_FILE_MAX = 128;
/** Max serialized JSON size the App accepts for one save. */
const ANNOTATIONS_JSON_MAX = 96 * 1024;
/** Reader-authored note bound (code points). */
const ANNOTATION_NOTE_MAX = 1000;
/** Anchor quote bound (code points). */
const ANNOTATION_QUOTE_MAX = 512;
/** Prefix/suffix bound (code points). */
const ANNOTATION_CONTEXT_MAX = 128;

function fileKeyOf(source: Record<string, unknown> | null): string {
  const key = source && typeof source.file_key === "string" ? source.file_key : "";
  if (!key || key.length > 2048) throw new Error("批注文件标识不合法");
  return key;
}

function boundString(value: unknown, cap: number): string {
  if (typeof value !== "string") return "";
  return Array.from(value).slice(0, cap).join("");
}

function normalizeAnnotation(raw: unknown, at: string): { id: string; createdAt: number; updatedAt: number; note: string; target: Record<string, unknown> } | null {
  if (raw === null || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const id = typeof value.id === "string" && value.id.length > 0 && value.id.length <= 128 ? value.id : "";
  if (!id) return null;
  const note = boundString(value.note, ANNOTATION_NOTE_MAX);
  if (!note) return null;
  const target = value.target;
  if (target === null || typeof target !== "object") return null;
  const t = target as Record<string, unknown>;
  const kind = t.kind;
  const quote = boundString(t.quote, ANNOTATION_QUOTE_MAX);
  const prefix = boundString(t.prefix, ANNOTATION_CONTEXT_MAX);
  const suffix = boundString(t.suffix, ANNOTATION_CONTEXT_MAX);
  if (!quote) return null;
  const createdAt = typeof value.createdAt === "number" && Number.isFinite(value.createdAt) ? value.createdAt : Number(at) || 0;
  const updatedAt = typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt) ? value.updatedAt : createdAt;
  if (kind === "markdown") {
    return { id, createdAt, updatedAt, note, target: { kind: "markdown", quote, prefix, suffix } };
  }
  if (kind === "pdf-text") {
    const page = typeof t.page === "number" && Number.isInteger(t.page) && t.page >= 1 && t.page <= 100_000 ? t.page : 1;
    const contentHash = typeof t.contentHash === "string" ? t.contentHash.slice(0, 32) : "";
    return { id, createdAt, updatedAt, note, target: { kind: "pdf-text", page, quote, prefix, suffix, contentHash } };
  }
  return null;
}

export function set_file_annotations(context: unknown, parameters: unknown) {
  const rawJson = parameters !== null && typeof parameters === "object" && "payload" in parameters && typeof parameters.payload === "string" ? parameters.payload : "";
  if (!rawJson) throw new Error("批注载荷缺失");
  if (rawJson.length > ANNOTATIONS_JSON_MAX + 4096) throw new Error(`批注载荷超过 ${ANNOTATIONS_JSON_MAX + 4096} 字节上限`);
  let parsed: unknown;
  try { parsed = JSON.parse(rawJson); }
  catch { throw new Error("批注载荷不是合法 JSON"); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("批注载荷必须是对象");
  const wrapper = parsed as Record<string, unknown>;
  const fileKey = fileKeyOf(wrapper);
  const list = wrapper.annotations;
  if (!Array.isArray(list)) throw new Error("批注载荷缺少 annotations 数组");
  const at = context !== null && typeof context === "object" && "now" in context && typeof context.now === "string" ? context.now : "";
  const normalized = list
    .slice(0, ANNOTATIONS_PER_FILE_MAX)
    .map((item) => normalizeAnnotation(item, at))
    .filter((item): item is NonNullable<typeof item> => item !== null);
  return answer(context, "file_annotations_set", { file_key: fileKey, annotations: normalized }, { file_key: fileKey, count: normalized.length });
}
