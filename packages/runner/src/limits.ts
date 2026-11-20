/**
 * The canonical size and time limits for machine operations.
 *
 * ONE set, imported by both sides. The capability registry on the bot rejects
 * anything past these before a frame is built; the device enforces the same
 * numbers as a local backstop. When the two disagree, one of two bad things
 * happens: the central schema accepts a value the device then refuses (a
 * confusing failure after an approval the user already gave), or the device
 * accepts more than the schema described (an approval card that understated
 * what was about to run). A test asserts they match.
 *
 * Byte-valued limits are UTF-8 BYTES, matching the kernel's `maxLength`.
 */
// Prompts share the existing App wire budget, independent of start/append.
const SESSION_PROMPT_MAX_BYTES = 384 * 1024;

export const MACHINE_LIMITS = {
  /** `exec`/`list_dir`/`write_file` working directory and file paths. */
  pathMaxBytes: 4_096,
  execDefaultTimeoutMs: 60_000,
  /**
   * One synchronous `exec` call, not the work: longer work runs detached
   * (workspace jobs, or `setsid … &` writing a log) and is polled.
   */
  execTimeoutMaxMs: 300_000,
  /**
   * Inline stdout/stderr window, per stream: the head and tail halves. The
   * complete stream past it spills to a device file named in the answer.
   */
  execMaxOutputBytes: 100_000,
  /** One `read_file` window; `offset`/`next_offset` page any file size. */
  readFileMaxBytes: 1024 * 1024,
  /**
   * One `write_file` chunk; larger content is appended in further chunks. The
   * kernel's 512 KiB JSON argument envelope binds before this number does.
   */
  writeFileMaxBytes: 1024 * 1024,
  /** One `list_dir` page; `cursor`/`next_cursor` reach every entry. */
  listMaxEntries: 500,
  /** A browser-managed provider pause remains answerable for this long. */
  managedInteractionTtlMs: 10 * 60_000,
  /**
   * Legacy one-shot resume budget and Bot RPC observation budget. Provider-
   * native managed attachments are deliberately not bounded by this clock.
   */
  appendTimeoutMs: 11 * 60_000,
  appendMaxPromptBytes: SESSION_PROMPT_MAX_BYTES,
  /** `start_session` supervises only long enough to classify the launch. */
  startSupervisionMs: 10_000,
  /**
   * The first prompt may use the App wire's full declared-large-parameter
   * budget. The provider's model context is the semantic ceiling; this byte
   * bound only keeps one launch inside the existing 512 KiB request envelope.
   */
  startMaxPromptBytes: SESSION_PROMPT_MAX_BYTES,
  clientRequestIdMaxBytes: 128,
  workspaceIdMaxBytes: 64,
  workspaceLabelMaxBytes: 120,
  workspaceDisplayMaxBytes: 240,
  modelMaxBytes: 120,
  effortMaxBytes: 16,
  /** Device name, as registered. */
  deviceMaxBytes: 64,
  /** Session id / rollout uuid. */
  sessionIdMaxBytes: 200,
  terminalIdMaxBytes: 64,
  terminalInputMaxBytes: 16 * 1024,
  /** Session Plus file upload: device-local `/tmp`, multipart over Runner RPC. */
  sessionAttachmentChunkBytes: 256 * 1024,
  sessionAttachmentChunkBase64MaxBytes: Math.ceil((256 * 1024) / 3) * 4,
  // Numeric representation bound, not a file-size policy.
  sessionAttachmentMaxChunks: Number.MAX_SAFE_INTEGER,
  sessionAttachmentUploadIdMaxBytes: 24,
  sessionAttachmentNameMaxBytes: 200,
  sessionAttachmentMediaTypeMaxBytes: 128,

  // ── macOS GUI automation: target-local, fifteen-minute consent lease ──
  guiGrantIdMaxBytes: 64,
  guiControllerLabelMaxBytes: 160,
  guiTypeTextMaxBytes: 8_000,
  guiCoordinateMax: 100_000,
  guiClickCountMax: 3,
  guiScrollAmountMax: 20,
  guiDragDurationMaxMs: 3_000,
  guiControlTtlMs: 15 * 60_000,
  guiConsentTimeoutMs: 2 * 60_000,
  guiScreenshotMaxBytes: 5 * 1024 * 1024,
  guiScreenshotMaxWidth: 1_920,

  /**
   * One Codex app-server/exec-server WebSocket message may still be large, but
   * each trusted capability invocation that carries it must stay below the
   * kernel's 512 KiB JSON-argument ceiling. The relay fragments and restores
   * message boundaries; callers never raise the kernel-wide limit.
   */
  codexAgentRelayProtocol: "chunk-v1",
  codexAgentRelayFrameMaxBytes: 16 * 1024 * 1024,
  codexAgentRelayChunkBytes: 256 * 1024,
  codexAgentRelayChunkBase64MaxBytes: Math.ceil((256 * 1024) / 3) * 4,
  codexAgentRelayMaxChunks: 64,
  /** Keep one `codex_agent_read` result well below the 8 MiB adapter ceiling. */
  codexAgentRelayReadBatchBytes: 4 * 1024 * 1024,

  // ── workspace-files/v1: reading inside a REGISTERED workspace ──
  //
  // Separate from the `machine_*` numbers above even where they happen to be
  // equal, because they bound a different thing. `pathMaxBytes` bounds a path
  // the caller chose anywhere on the box; these bound a path relative to a root
  // the device itself resolved. Writing them as one constant would mean raising
  // one of them silently raises the other.
  /** A POSIX path relative to the workspace root. */
  workspaceRelativePathMaxBytes: 4_096,
  /**
   * Entries ONE directory listing page may return. A page, not the total:
   * `after` (the previous page's last `<kind>/<name>`) reaches every entry.
   */
  workspaceListMaxEntries: 500,
  /** `directory/` plus a 255-character name of up to four UTF-8 bytes each. */
  workspaceListCursorMaxBytes: "directory/".length + 255 * 4,
  /**
   * Byte offset a file window may start at. A numeric representation bound,
   * not a file-size policy: a window costs O(window) on the device, so a file
   * of any size can be read, previewed or downloaded window by window.
   */
  workspaceFileMaxOffset: Number.MAX_SAFE_INTEGER,
  /** The largest window one `read_workspace_text` call may return. */
  workspaceTextChunkMaxBytes: 256 * 1024,
  /** The largest raw window returned before base64 transport encoding. */
  workspaceMediaChunkMaxBytes: 256 * 1024,
  /**
   * The text ONE `replace_workspace_text` / `replace_owner_text` call carries,
   * in bytes — a window, not a file-size policy (2026-10-20).
   *
   * The capability kernel caps a single call's arguments at 512 KiB of JSON,
   * so a replacement larger than this is staged: `stage: "begin"` → `append`
   * windows into a sibling temp file → `commit`, which performs the same CAS
   * and atomic rename as a one-call replace. The adapter still measures the
   * encoded form (`argsTooLarge`), because a window of control characters
   * encodes to six bytes each.
   */
  workspaceWriteMaxBytes: 256 * 1024,
  /** A staged replacement's token: 32 lowercase hex characters. */
  workspaceUploadIdMaxBytes: 32,
} as const;

export type MachineLimits = typeof MACHINE_LIMITS;
