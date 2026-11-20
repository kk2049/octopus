/**
 * The wire vocabulary of `agent-sessions/v1`.
 *
 * ── Why the strings live here and not in the App ────────────────────────────
 *
 * They are the contract. An App that spelled `"open_session"` inline would be
 * re-deciding the protocol at every call site, and the first typo would be a
 * silently refused action rather than a compile error. Putting them in the
 * contract package means the adapter that maps a port onto a transport says
 * `SESSION_ACTIONS.readWindow` — one definition, checked by the compiler, and
 * greppable when the operation catalog changes.
 *
 * ── Why the ids are not the port's method names ─────────────────────────────
 *
 * Because they answer different questions. A method name is what a module asks
 * for; an action id is what the trusted side is asked to do — and the two are
 * deliberately not one-to-one:
 *
 *  · `append` and `resume` are two module intentions that the permission layer
 *    treats as ONE persistent authorisation (`append_session`). The View action
 *    id stays separate so the approval card and the audit record say which one a
 *    person actually asked for.
 *  · `pin` writes App-owned durable state and touches no user resource at all;
 *    it happens to travel over the same channel.
 *
 * `SESSION_OPERATIONS` is the other half: the Gate token each action ends up
 * costing. It is here so a consumer can SAY what a composition asks for without
 * being able to grant it — deriving a request is not the same as authorising it,
 * and only the trusted Host has the catalog that turns one into the other.
 */

export const AGENT_SESSIONS_CONTRACT = "agent-sessions/v1";

/** Content-free Agent View wake key; receiving it authorises no data access. */
export const AGENT_SESSIONS_WAKE_REF = "sessions";

/** Action ids as they cross the App's transport. */
export const SESSION_ACTIONS = Object.freeze({
  refreshSessions: "refresh_sessions",
  search: "search_sessions",
  readWindow: "open_session",
  closeSession: "close_session",
  listWorkspaces: "refresh_workspaces",
  start: "start_session",
  append: "append_session",
  resume: "resume_session",
  takeover: "takeover_session",
  fallback: "fallback_session",
  interrupt: "interrupt_session",
  releaseControl: "release_session_control",
  respondInteraction: "respond_agent_interaction",
  pin: "pin_session",
  saveFolder: "save_session_folder",
  deleteFolder: "delete_session_folder",
  fileSessions: "file_sessions",
  setTitle: "set_session_title",
  readContinuation: "read_codex_continuation",
  saveContinuation: "save_codex_continuation",
  markReviewed: "review_session",
  setFileAnnotations: "set_file_annotations",
  attachFile: "attach_file",
  openTerminal: "open_terminal",
  readTerminal: "read_terminal",
  sendTerminal: "send_terminal",
  closeTerminal: "close_terminal",
} as const);

export type SessionActionId = (typeof SESSION_ACTIONS)[keyof typeof SESSION_ACTIONS];

/** Closed user-facing permission profiles shared by Claude Code and Codex. */
export const AGENT_PERMISSION_PROFILES = Object.freeze({ fullAccess: "full_access", manual: "manual" } as const);
export type AgentPermissionProfile = (typeof AGENT_PERMISSION_PROFILES)[keyof typeof AGENT_PERMISSION_PROFILES];
/**
 * The Gate operation each action is served by, where there is one.
 *
 * `pin_session`, the three folder actions, `set_session_title`,
 * `review_session` and `set_file_annotations` are absent because they only
 * write the App's own durable state.
 * `respond_agent_interaction` is absent because the provider prompt itself is
 * the human approval surface; the trusted Host serves it through a separate,
 * single-use interaction capability rather than a standing App grant.
 *
 * `close_session` only releases this instance's transcript subscription; it
 * neither reads a resource nor controls the Agent and spends no Gate token.
 *
 * Every other resource action maps to the exact token a release must disclose.
 * In particular, `attach_file` writes bytes on the selected session's device,
 * so it spends `upload_session_file`; treating it as host-local scratch would
 * silently widen the App after consent.
 */
export const SESSION_OPERATIONS = Object.freeze({
  refresh_sessions: "list_recent_sessions",
  search_sessions: "search_sessions",
  open_session: "read_session",
  read_codex_continuation: "read_session",
  save_codex_continuation: "append_session",
  refresh_workspaces: "list_session_workspaces",
  start_session: "start_session",
  append_session: "append_session",
  attach_file: "upload_session_file",
  // Resuming an idle session is the same persistent authorisation as appending
  // to a live one; only the wording on the approval card differs.
  resume_session: "append_session",
  // Explicitly cancelling an observed CLI before resuming is a distinct human
  // intent, but it spends the same one-turn execution authority.
  takeover_session: "append_session",
  // An explicit cross-account fork preserves the source and runs one new
  // thread; it spends the same one-turn execution authority as resume.
  fallback_session: "append_session",
  // Native provider interrupt shares the existing one-turn execution grant;
  // the human-only action and audit identity remain distinct.
  interrupt_session: "append_session",
  // Releasing a completed, Runner-owned Codex attachment changes control of
  // the same session. It is a distinct human intent and audit row, but does
  // not widen the persistent execute grant.
  release_session_control: "append_session",
  // Opening is the one trusted approval handshake. The three follow-up actions
  // spend only the opaque lease returned by that approved opening.
  open_terminal: "open_workspace_terminal",
  read_terminal: "workspace_terminal",
  send_terminal: "workspace_terminal",
  close_terminal: "workspace_terminal",
} as const);

/** Parameter names, so an adapter and a test agree without a second literal. */
export const SESSION_PARAMS = Object.freeze({
  resource: "resource",
  limit: "limit",
  offset: "offset",
  block: "block",
  field: "field",
  charOffset: "char_offset",
  cursor: "cursor",
  source: "source",
  query: "query",
  device: "device",
  runtimeDevice: "runtime_device",
  codexAccount: "codex_account",
  directory: "directory",
  workspaceId: "workspace_id",
  workspaceLabel: "workspace_label",
  workspaceDisplay: "workspace_display",
  model: "model",
  effort: "effort",
  permissionProfile: "permission_profile",
  translatePrompt: "translate_prompt",
  prompt: "prompt",
  session: "session",
  sessions: "sessions",
  pinned: "pinned",
  folder: "folder",
  title: "title",
  completedAt: "completed_at",
  annotationsPayload: "payload",
  interactionId: "interaction_id",
  responseJson: "response_json",
  name: "name",
  mediaType: "media_type",
  data: "data",
  uploadId: "upload_id",
  chunkIndex: "chunk_index",
  chunkCount: "chunk_count",
  terminalId: "terminal_id",
  input: "input",
  cols: "cols",
  rows: "rows",
} as const);

/** Read every source the account can reach, rather than one device. */
export const ALL_SOURCES = "all";
