/**
 * `@claude-bot/agent-sessions-contract` — the `agent-sessions/v1` ABI.
 *
 * The projected shape, the action/operation vocabulary, and the typed port that
 * a session roster, a search box and a chat are written against. No React, no
 * transport, no Bot: three different consumers have to agree about this and only
 * one of them renders.
 *
 * The state model this contract fixes, in one place, because it is the thing
 * that keeps being got wrong:
 *
 *   Host / provider      session, transcript and workspace facts; operation
 *                        lifecycle; permission; durable pins
 *   sessions controller  request queueing, paging, the stable selection derived
 *                        from a projection, once-only completion handling
 *   view module          search input, composer draft, tree expansion, the
 *                        new-session form, current display mode
 *   workspace shell      slots, panel identity, focus/open/close
 *   App                  adapting a transport onto this port, and choosing which
 *                        module instances exist
 */

export { DEFAULT_CODEX_CONTINUATION, CODEX_CONTINUATION_MAX_LENGTH, CODEX_CONTINUATION_PROTOCOL, validateCodexContinuationPrompt, readCodexContinuationSettings, type CodexContinuationSettings } from "./continuation.js";

export { readSessionTurnConfiguration, type SessionTurnConfiguration } from "./turn-configuration.js";
export { promptMatchKey, unwrapPastedContent } from "./prompt-text.js";

export {
  SESSION_PRIMARY_WINDOW, SESSION_CHILD_WINDOW, SESSION_AUTOMATED_WINDOW, SESSION_ROSTER_WINDOW,
  SESSION_LIST_START_CURSOR, SESSION_IDS_MAX,
  selectSessionWindow, isForegroundTmuxSession, isAutomatedSession, sessionHistoryPage, sessionListCursor,
  encodeSessionIds, decodeSessionIds, type SessionWindowOptions,
} from "./roster-window.js";
export { QUIET_MS, TOOL_STALE_MS, activityPhase, isBusy, shouldFollow, silenceOf, type ActivityPhase } from "./activity.js";

export {
  AGENT_PERMISSION_PROFILES, type AgentPermissionProfile,
  AGENT_SESSIONS_CONTRACT,
  AGENT_SESSIONS_WAKE_REF,
  ALL_SOURCES,
  SESSION_ACTIONS,
  SESSION_OPERATIONS,
  SESSION_PARAMS,
  type SessionActionId,
} from "./actions.js";

export {
  BOT_HOST_DEVICE,
  SESSION_CLI_KINDS,
  compareTranscriptVersions,
  currentRuntimeOf,
  reconcileTranscriptWindows,
  type AgentInteraction,
  type AgentInteractionOption,
  type AgentInteractionQuestion,
  type AgentRuntime,
  type Activity,
  type AnnotationTarget,
  type AnnotationTargetMarkdown,
  type AnnotationTargetPdf,
  type CliKind,
  type AgentBackendAvailability,
  type CodexAccountRegistration,
  type FileAnnotation,
  type PlacementDevice,
  type RichBlock,
  type RichMessage,
  type SearchHit,
  type SearchResult,
  type SessionFolder,
  type SessionSummary,
  type SessionsProjection,
  type SourceRow,
  type TranscriptStatus,
  type TranscriptVersion,
  type TranscriptVersionRelation,
  type TranscriptWindow,
  transcriptVersionOf,
  type WorkspaceAccessRow,
  type WorkspaceGroup,
  type WorkspaceRow,
} from "./projection.js";

export {
  READ_ONLY_REFUSAL,
  SESSION_OPERATION_FIELDS,
  operationOutcomePhase,
  type OperationOutcomePhase,
  type AgentInteractionResponse,
  type ReadBlockRequest,
  type ReadWindowRequest,
  type SessionOperation,
  type SessionInputReceipt,
  type SessionsPhase,
  type AttachedFile,
  type AttachFileChunkRequest,
  type SessionsPort,
  type SessionsReply,
  type SessionsSnapshot,
  type StartSessionRequest,
  type TerminalSize,
  type TerminalSnapshot,
} from "./port.js";

export { createSessionCommands } from './commands.js';

export * from "./usage.js";

export { AGENT_EFFORT_LEVELS, AGENT_EFFORTS, DEFAULT_CODEX_MODEL, MODELS, publicModelChoices, isAgentEffort, type ModelChoice } from "./providers.js";
