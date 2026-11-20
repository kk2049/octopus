/**
 * The vocabulary and the numbers of `workspace-files/v1`.
 *
 * Two vocabularies, and they are deliberately not the same list:
 *
 *  · `WORKSPACE_FILES_ACTIONS` is what a consumer can ASK for — four verbs, one
 *    per port method.
 *  · `WORKSPACE_FILES_OPERATIONS` is which permission token each verb spends.
 *    Stating it here lets a permission summary say what a composition requests
 *    without the trusted Host having to guess; GRANTING those tokens remains the
 *    Host's catalog's job, and nothing in this package can do it.
 *
 * `refresh_roots` reuses the workspace-registry enumeration that already exists,
 * which is why the read half adds exactly two new operation names rather than
 * three.
 *
 * `replace_text` (2026-08-07) is the first verb here that changes anything. It
 * spends its own token, it is never auto-allowed, and it is expressed as a
 * compare-and-swap — see `write.ts`.
 */

export const WORKSPACE_FILES_CONTRACT = "workspace-files/v1";

/**
 * Resource kind carried by `open-resource/v1` for text this contract can read.
 * It lives with the port ABI so an alternative editor/previewer does not need
 * to depend on the existing FileViewer package merely to name compatible data.
 */
export const WORKSPACE_TEXT_RESOURCE_KIND = "workspace-text";

export const WORKSPACE_FILES_ACTIONS = Object.freeze([
  "refresh_roots",
  "list_directory",
  "open_text",
  "replace_text",
] as const);

export type WorkspaceFilesActionId = (typeof WORKSPACE_FILES_ACTIONS)[number];

/** The read half, for a consumer that wants to say "I only ever look". */
export const WORKSPACE_FILES_READ_ACTIONS = Object.freeze([
  "refresh_roots",
  "list_directory",
  "open_text",
] as const satisfies readonly WorkspaceFilesActionId[]);

export const WORKSPACE_FILES_OPERATIONS: Readonly<Record<WorkspaceFilesActionId, string>> = Object.freeze({
  refresh_roots: "list_session_workspaces",
  list_directory: "list_workspace_entries",
  open_text: "read_workspace_text",
  replace_text: "replace_workspace_text",
});

export const WORKSPACE_FILES_LIMITS = Object.freeze({
  /**
   * Registered workspaces ONE roots answer may project — a page, not the total:
   * `refreshRoots(after)` continues after the last root (see `paging.ts`).
   */
  maxRoots: 64,
  /**
   * Entries ONE directory listing may project — a page, not the total:
   * `listDirectory(ref, after)` continues after the last entry (`paging.ts`).
   */
  maxEntries: 500,
  /** A display label: a POSIX file name is at most 255 bytes. */
  maxLabelLength: 255,
  /**
   * An opaque ref. Bounded at the same 200 characters `ResourceLink.ref` allows,
   * so anything this contract mints can travel as an `open-resource/v1` link.
   */
  maxRefLength: 200,
  /**
   * The largest text file size this contract can describe. A numeric
   * representation bound, not a policy (2026-10-20): every read is a bounded
   * window, so a text file of any size can be read to its end.
   */
  maxTextBytes: Number.MAX_SAFE_INTEGER,
  /**
   * What a whole-document view loads before it stops and asks.
   *
   * A browser view holds the whole text in one string and one editor model, so
   * it needs a budget the protocol does not. Past it the view keeps what it
   * loaded, says so, and offers to load the rest or download the file; nothing
   * is refused and nothing is presented as complete. `exceedsTextLimit` on a
   * listing row means the file is larger than this.
   */
  wholeTextBytes: 16 * 1024 * 1024,
  /**
   * The most a whole-document view loads even when a person asks for all of
   * it. Not a protocol bound — the port, downloads and agents read any size —
   * but a measured browser one: the text, its lines and the editor model take
   * several times the file in page memory, and in a 4 GiB browser 100 MiB
   * loaded whole while 200 MiB crashed the tab. Past this a view offers the
   * download instead of a crash.
   */
  wholeTextMaxBytes: 128 * 1024 * 1024,
  /**
   * The largest text ONE `replace_text` call carries, in UTF-8 bytes — a window,
   * not a file-size policy (2026-10-20).
   *
   * Every layer below bounds one call's arguments (the View wire's one raised
   * parameter, the Gate's 512 KiB of JSON), so a replacement larger than this
   * travels as a staged upload: `begin` → `append` windows → `commit`, where
   * commit performs the same compare-and-swap and atomic rename as a one-call
   * replace (see `write.ts`). A file of any size can therefore be saved.
   */
  maxWriteTextBytes: 256 * 1024,
  /** The largest window one pull may carry. */
  textChunkBytes: 256 * 1024,
  maxMediaTypeLength: 128,
  /** Refusal text: written for a person, and it ends up in a log. */
  maxMessageLength: 200,
  /** `sha256:` plus 64 hex characters. */
  maxDigestLength: 71,
  /** An opaque mutation id the trusted side mints. Compared, never parsed. */
  maxMutationIdLength: 64,
});

/** Text this contract can open. UTF-8 is the only encoding it states. */
export const WORKSPACE_TEXT_MEDIA_TYPE = "text/plain; charset=utf-8";

/** The payload contract id carried in the stream's metadata. */
export const WORKSPACE_TEXT_CHUNK_PAYLOAD = "workspace-files/v1#text-chunk";

/**
 * What a listed thing is.
 *
 * `other` is everything that is not a plain file or a plain directory —
 * symlinks, sockets, devices. It exists so that a listing can say "there is
 * something here" without this contract having to pretend it can open it, and
 * entries of this kind are minted WITHOUT a ref: a consumer that cannot name
 * them cannot ask for them.
 */
export const WORKSPACE_ENTRY_KINDS = Object.freeze(["file", "directory", "other"] as const);

export type WorkspaceEntryKind = (typeof WORKSPACE_ENTRY_KINDS)[number];

export function isWorkspaceEntryKind(value: unknown): value is WorkspaceEntryKind {
  return typeof value === "string" && (WORKSPACE_ENTRY_KINDS as readonly string[]).includes(value);
}

/**
 * Every way this port can say no.
 *
 * All of them RESOLVE. "No permission", "revoked", "too big" and "not text" are
 * answers a person needs to read, not exceptions a component has to catch — and
 * an exception on this path is how a viewer ends up showing a stack trace with a
 * canonical path in it.
 */
export const WORKSPACE_FILES_REFUSALS = Object.freeze([
  /** The ref was never minted here, belongs to another scope, or has expired. */
  "unknown_ref",
  /** A directory ref was submitted where a file ref was required, or the reverse. */
  "wrong_kind",
  /** The scope this ref belonged to has been closed. */
  "scope_closed",
  /** No authority is bound for this resource. */
  "no_authority",
  /** A human has to approve this read first. */
  "approval_required",
  "not_found",
  "not_a_directory",
  "not_a_file",
  /** The bytes are not valid UTF-8, so this contract will not claim they are text. */
  "not_text",
  /** Bigger than what this consumer or call can take whole. Never a silent truncation. */
  "too_large",
  /** It resolved outside the registered workspace — a symlink out, typically. */
  "outside_workspace",
  /** The device or the operating system refused. */
  "denied",
  /** The device is unreachable, or the backend failed. */
  "unavailable",
  /** The request itself was malformed. */
  "invalid_request",
  /**
   * The file is not the version this edit was based on. NOTHING was written.
   *
   * Distinct from `denied` because it is the only refusal on this contract that
   * tells a person what to do next: re-open the file and reapply the change.
   */
  "digest_mismatch",
  /**
   * This port does not write — as opposed to "this write was refused".
   *
   * Two situations produce it, and both are structural rather than momentary:
   * the port implementation offers no write at all (a read-only harness, a
   * transport that cannot carry a file body), or this scope's authority covers
   * the reads and not the write. Neither is worth retrying, and neither reaches
   * a device.
   */
  "read_only",
] as const);

export type WorkspaceFilesRefusalCode = (typeof WORKSPACE_FILES_REFUSALS)[number];

export function isWorkspaceFilesRefusalCode(value: unknown): value is WorkspaceFilesRefusalCode {
  return typeof value === "string" && (WORKSPACE_FILES_REFUSALS as readonly string[]).includes(value);
}
