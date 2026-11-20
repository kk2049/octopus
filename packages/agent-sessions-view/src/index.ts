/**
 * `@claude-bot/agent-sessions-view` — the reusable sessions surfaces.
 *
 * Seven modules over one `agent-sessions/v1` port: search, two navigation
 * arrangements, chat, the new-agent form, operation status and a device-keyed
 * remote terminal. Plus the controller that keeps them coherent and the context
 * that binds them to a port.
 *
 * ── What this package may depend on, and what it may not ────────────────────
 *
 * May: React, `@claude-bot/agent-sessions-contract`, `@claude-bot/agent-module-contract`,
 * and the Agent View SDK's PRESENTATION half (`@claude-bot/agent-view-react/ui`
 * and `/workspace`).
 *
 * May not: any App, any transport, any wire constant, any channel primitive and
 * no `propose()` — a module has a port, and only the App that owns the channel
 * knows what is on the other end of it. `architecture.test.ts` enforces that by
 * reading this package's own source (including this sentence), because an import
 * boundary that only lives in a review comment is not a boundary.
 *
 * This bundle entry explicitly installs the neutral chat baseline and the
 * sessions-only stylesheet; component subpaths remain side-effect-free.
 */

import "@claude-bot/chat-ui-commons/transcript-ui.css";
import "./sessions.css";
import "./chat-controls.css";

export { SessionsProvider, useSessions, useSessionResource, useSessionNavigation, type SessionsProviderProps } from "./context.js";
export {
  useSessionsController,
  type NewSessionDraft,
  type PendingLaunch,
  type SessionsController,
} from "./controller.js";
export type {
  ComposerDraftPersistence,
  ComposerDraftRecord,
  ComposerDraftSubmission,
} from "./composer-drafts.js";
export { NEW_SESSION_PROMPT_DRAFT_RESOURCE } from "./composer-drafts.js";

export { SESSIONS_MODULES } from "./modules.js";
export { SessionsRefreshAction, type SessionsRefreshActionProps } from "./chrome.js";
export {
  AGENT_CHAT_MANIFEST,
  AGENT_CHAT_MODULE_ID,
  NEW_SESSION_MANIFEST,
  NEW_SESSION_MODULE_ID,
  NEW_SESSION_RESOURCE,
  REMOTE_TERMINAL_MANIFEST,
  REMOTE_TERMINAL_MODULE_ID,
  REMOTE_TERMINAL_RESOURCE_KIND,
  SESSIONS_MANIFESTS,
  SESSION_DIRECTORY_INDEX_CONFIG,
  SESSION_DIRECTORY_INDEX_MANIFEST,
  SESSION_DIRECTORY_INDEX_MODULE_ID,
  SESSION_OPERATIONS_MANIFEST,
  SESSION_OPERATIONS_MODULE_ID,
  SESSION_ROSTER_MANIFEST,
  SESSION_ROSTER_MODULE_ID,
  SESSION_SEARCH_MANIFEST,
  SESSION_SEARCH_MODULE_ID,
} from "./manifests.js";

// The presentational components, for a consumer that composes them itself — a
// read-only harness, a test, or a future workspace with a different rail.
export { AgentChat, type AgentChatProps } from "./components/AgentChat.js";
export {
  AgentInteractionCard,
  type AgentInteractionCardProps,
} from "./components/AgentInteractionCard.js";
export {
  NewSession,
  directoryHint,
  type NewSessionLaunch,
  type NewSessionProps,
} from "./components/NewSession.js";
export { EFFORTS, MODELS, modelChoices, normalizeEffort, type ModelChoice } from "./lib/cli.js";
export { SessionOperations, type SessionOperationsProps } from "./components/SessionOperations.js";
export {
  DirectoryIndex,
  type DirectoryIndexProps,
  type SessionDirectoryTarget,
} from "./components/DirectoryIndex.js";
export {
  DirectorySessionsDialog,
  type DirectorySessionsDialogProps,
} from "./components/DirectorySessionsDialog.js";
export { SessionRoster, SessionRow, type SessionRosterProps } from "./components/SessionRoster.js";
export { SessionSearch, type SessionSearchProps } from "./components/SessionSearch.js";
export { TranscriptView, type TranscriptViewProps } from "./components/Transcript.js";
export {
  ChatTurn,
  TranscriptGroupView,
  type ChatTurnClasses,
  type ChatTurnProps,
  type TranscriptGroupClasses,
  type TranscriptGroupViewProps,
} from "./components/TranscriptGroup.js";
export {
  ChatScroller,
  ChatTranscript,
  SHARED_CHAT_CLASSES,
  type ChatScrollerProps,
  type ChatTranscriptClasses,
  type ChatTranscriptProps,
} from "./components/ChatTranscript.js";

export {
  MIN_TAIL_UNITS,
  TAIL_EXTEND_CAP,
  TRANSCRIPT_PAGE,
  devicesOf,
  rosterOf,
  sortedSessions,
  tailNeedsMore,
  titleOf,
  transcriptOf,
  workspaceMap,
} from "./lib/projection.js";

export {
  buildDirTree,
  isResolvableDir,
  pathTo,
  sortRecentSessions,
  type DeviceGroup,
  type DirNode,
  type RosterSession,
} from "./lib/roster.js";

export {
  FILES_UNAVAILABLE_NOTE,
  IDLE_DIRECTORY_MS,
  directKeyOf,
  directoryIndexRows,
  fileLayer,
  idleKeyOf,
  newestActivity,
  type DirectoryIndexInput,
  type IndexRow,
} from "./lib/directory-index.js";

export {
  sessionsInDirectorySubtree,
  type DirectorySessionMatch,
  type DirectorySessionsInput,
} from "./lib/directory-sessions.js";

export {
  homeDirectoryRows,
  homePathSegments,
  type HomeDirectoryRow,
  type HomeDirectoryTreeInput,
} from "./lib/home-directory-tree.js";

export {
  filePathOf,
  findFilePaths,
  linkifyFilePaths,
} from "./lib/file-mentions.js";

export {
  isFileishLink,
  pathSegments,
  planWalk,
  relativeLinkSegments,
  resolveLinkPath,
  walkToFile,
  type ListDirectory,
  type WalkCandidate,
  type WalkPlan,
  type WalkRefusal,
  type WalkResolved,
} from "./lib/file-link.js";

export {
  activityLabel,
  activityPhase,
  activityStatus,
  countUnits,
  entriesOf,
  formatElapsed,
  formatTime,
  groupEntries,
  isBusy,
  isRecent,
  isWork,
  shouldFollow,
  silenceOf,
  type ActivityPhase,
  type TranscriptGroup,
  type ViewEntry,
  type ViewEntryKind,
} from "./lib/transcript.js";
