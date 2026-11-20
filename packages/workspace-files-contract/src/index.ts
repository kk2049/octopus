/**
 * `@claude-bot/workspace-files-contract` — the read half of `workspace-files/v1`.
 *
 * A consumer of this contract can enumerate the workspaces it was given, walk
 * directories inside them, and read a text file as a bounded pull stream. It
 * cannot name a path, cannot say which machine, and cannot state who it is —
 * every one of those is absent from the ABI rather than checked, and the trusted
 * provider on the other side rebinds an opaque ref to (device, workspace,
 * relative path) where a consumer cannot reach.
 *
 * v1 was read only until 2026-08-07, when it gained exactly one write:
 * `replace_text`, an expected-digest compare-and-swap that answers with a
 * mutation receipt. That was a permission-contract change and it is spelled as
 * one — a new operation token, a new Object version on the trusted side, and a
 * new contract for any release that wants it. There is still no watch, no
 * append, no patch and no create.
 */

export {
  WORKSPACE_ENTRY_KINDS,
  WORKSPACE_FILES_ACTIONS,
  WORKSPACE_FILES_CONTRACT,
  WORKSPACE_FILES_LIMITS,
  WORKSPACE_FILES_OPERATIONS,
  WORKSPACE_FILES_READ_ACTIONS,
  WORKSPACE_FILES_REFUSALS,
  WORKSPACE_TEXT_CHUNK_PAYLOAD,
  WORKSPACE_TEXT_MEDIA_TYPE,
  WORKSPACE_TEXT_RESOURCE_KIND,
  isWorkspaceEntryKind,
  isWorkspaceFilesRefusalCode,
  type WorkspaceEntryKind,
  type WorkspaceFilesActionId,
  type WorkspaceFilesRefusalCode,
} from "./limits.js";

export {
  WORKSPACE_FILES_DECLARATION,
  WORKSPACE_FILES_REFUSAL_VOCABULARY,
  WORKSPACE_FILES_WIRE_ACTIONS,
  WORKSPACE_MUTATION_UNDO,
  isWorkspaceContentDigest,
  readWorkspaceMutationReceipt,
  type WorkspaceMutationReceipt,
  type WorkspaceMutationUndo,
  type WorkspaceReplaceTextInput,
} from "./write.js";

export {
  readWorkspaceFilesDirectory,
  readWorkspaceFilesEntry,
  readWorkspaceFilesRoot,
  readWorkspaceFilesRoots,
  readWorkspaceTextChunk,
  readWorkspaceTextDocument,
  utf8ByteLength,
  type WorkspaceFilesDirectory,
  type WorkspaceFilesEntry,
  type WorkspaceFilesRoot,
  type WorkspaceFilesRoots,
  type WorkspaceTextChunk,
  type WorkspaceTextDocument,
} from "./projection.js";

export {
  workspaceFilesCanWrite,
  workspaceFilesRefusal,
  type WorkspaceFilesPort,
  type WorkspaceFilesRefusal,
  type WorkspaceFilesReply,
  type WorkspaceFilesWritablePort,
  type WorkspaceTextOpen,
} from "./port.js";

export {
  RESOURCE_ACTIONS,
  RESOURCE_PARAMS,
  WORKSPACE_FILES_DIALECT_V1,
  WORKSPACE_FILES_PROPOSAL_ACTIONS,
  createRemoteWorkspaceFilesPort,
  readWorkspaceTextOpenPayload,
  type ProposalAnswer,
  type ProposalTransport,
  type RemoteWorkspaceFiles,
  type WorkspaceFilesDialect,
  type WorkspaceTextOpenPayload,
} from "./remote.js";

/**
 * ── `workspace-files/v2` ───────────────────────────────────────────────────
 *
 * v1 plus one optional field: an opaque `directoryKey` that says "this row and
 * that row are the same real directory" without saying which directory. It is a
 * second contract id rather than a field on v1 because v1's readers refuse
 * unknown fields, and that refusal is load-bearing — see `projection-v2.ts`.
 *
 * The verbs, the permission tokens, the Runner operations and the capability
 * Object are v1's, unchanged. A release binds exactly one of the two.
 */
export {
  WORKSPACE_DIRECTORY_KEY_MAX_LENGTH,
  WORKSPACE_DIRECTORY_KEY_PREFIX,
  isWorkspaceDirectoryKey,
} from "./directory-key.js";

export {
  WORKSPACE_FILES_CONTRACT_V2,
  readWorkspaceFilesDirectoryV2,
  readWorkspaceFilesEntryV2,
  readWorkspaceFilesRootV2,
  readWorkspaceFilesRootsV2,
  type WorkspaceFilesDirectoryV2,
  type WorkspaceFilesEntryV2,
  type WorkspaceFilesRootV2,
  type WorkspaceFilesRootsV2,
} from "./projection-v2.js";

export {
  WORKSPACE_FILES_DECLARATION_V2,
  WORKSPACE_FILES_DIALECT_V2,
  WORKSPACE_FILES_PROPOSAL_ACTIONS_V2,
  createRemoteWorkspaceFilesPortV2,
  type AnyWorkspaceFilesPort,
  type RemoteWorkspaceFilesV2,
  type WorkspaceFilesPortV2,
} from "./remote-v2.js";

export {
  RESOLVE_PATH_PARAM,
  RESOURCE_RESOLVE_PATH_ACTION,
  WORKSPACE_FILES_RESOLVE_OPERATION,
  WORKSPACE_RESOLVE_LIMITS,
  readWorkspaceResolvedEntry,
  workspaceResolveLabelsProblem,
  type WorkspaceResolvedEntry,
} from "./resolve.js";

export {
  WORKSPACE_FILES_CONTRACT_V3,
  WORKSPACE_FILES_DECLARATION_V3,
  WORKSPACE_MEDIA_ACTION,
  WORKSPACE_MEDIA_CHUNK_PAYLOAD,
  WORKSPACE_MEDIA_LIMITS,
  WORKSPACE_MEDIA_OPERATION,
  WORKSPACE_MEDIA_RESOURCE_KIND,
  WORKSPACE_MEDIA_TYPES,
  base64ByteLength,
  isWorkspaceMediaType,
  readWorkspaceMediaChunk,
  isWorkspaceMediaLabel,
  readWorkspaceMediaDocument,
  workspaceMediaRefusal,
  type WorkspaceMediaChunk,
  type WorkspaceMediaDocument,
  type WorkspaceMediaOpen,
  type WorkspaceMediaPort,
  type WorkspaceMediaRefusalCode,
  type WorkspaceMediaReply,
  type WorkspaceMediaType,
} from "./media.js";

export {
  RESOURCE_OPEN_MEDIA_ACTION,
  WORKSPACE_FILES_PROPOSAL_ACTIONS_V3,
  WORKSPACE_FILES_DIALECT_V3,
  createRemoteWorkspaceFilesPortV3,
  type RemoteWorkspaceFilesV3,
  type WorkspaceFilesPortV3,
} from "./remote-v3.js";

export {
  WORKSPACE_DOWNLOAD_ACTION,
  WORKSPACE_DOWNLOAD_CHUNK_PAYLOAD,
  WORKSPACE_DOWNLOAD_LIMITS,
  WORKSPACE_DOWNLOAD_MEDIA_TYPE,
  WORKSPACE_DOWNLOAD_OPERATION,
  WORKSPACE_DOWNLOAD_STALL_MS,
  WORKSPACE_DOWNLOAD_OPEN_STALL_MS,
  WORKSPACE_FILES_CONTRACT_V4,
  WORKSPACE_FILES_DECLARATION_V4,
  collectWorkspaceDownload,
  readWorkspaceDownloadChunk,
  readWorkspaceDownloadDocument,
  workspaceDownloadRefusal,
  type CollectedWorkspaceDownload,
  type WorkspaceDownloadChunk,
  type WorkspaceDownloadDocument,
  type WorkspaceDownloadOpen,
  type WorkspaceDownloadPort,
  type WorkspaceDownloadReply,
} from "./download.js";

export {
  RESOURCE_DOWNLOAD_FILE_ACTION,
  WORKSPACE_FILES_DIALECT_V4,
  WORKSPACE_FILES_PROPOSAL_ACTIONS_V4,
  createRemoteWorkspaceFilesPortV4,
  type RemoteWorkspaceFilesV4,
  type WorkspaceFilesPortV4,
} from "./remote-v4.js";
export * from "./file-link.js";

export {
  RESOURCE_PAGE_PARAM,
  WORKSPACE_ENTRY_KIND_RANK,
  WORKSPACE_LIST_CURSOR_MAX_LENGTH,
  compareWorkspaceListPositions,
  readWorkspaceListCursor,
  workspaceListCursor,
  workspaceListCursorAfter,
  type WorkspaceListPosition,
} from "./paging.js";

export {
  WORKSPACE_TEXT_UPLOAD_STAGES,
  WORKSPACE_TEXT_WINDOW_ENCODED_BYTES,
  appendWorkspaceTextWindows,
  isWorkspaceTextUploadToken,
  readWorkspaceTextUpload,
  replaceWorkspaceTextInWindows,
  workspaceTextWindows,
  type WorkspaceTextUpload,
  type WorkspaceTextUploadStage,
  type WorkspaceTextUploadSteps,
} from "./upload.js";
