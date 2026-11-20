/**
 * Shared App hooks, context, lifecycle and presentation.
 * The shell mounts an independently released App in its React tree and supplies
 * a caller-owned direct runtime. Resource authorization stays on the server.
 * Narrow /ui and /workspace entries keep reusable modules transport-neutral.
 */

/**
 * The wire vocabulary, re-exported from its single home in
 * `@claude-bot/web-trust/frame-protocol`.
 *
 * Re-exported rather than redefined: both sides of this boundary must import
 * ONE definition, and the trusted half lives in a different bundle that already
 * imports it from there. An App gets the constants without adding a dependency
 * on a package whose other exports are server-side trust machinery — and
 * without anyone being tempted to write a second copy that agrees today.
 */
export {
  APPEARANCE_CONTRACT,
  APPEARANCE_THEME_ID_MAX_LEN,
  APPEARANCE_THEME_ID_PATTERN,
  MSG,
  PORT_MESSAGE_BYTES,
  PORT_WINDOW_MESSAGES,
  PORT_WINDOW_MS,
  READY_TIMEOUT_MS,
  SESSION_PLUS_PROTOCOL,
  VIEW_HELLO,
  VIEW_RECONNECT,
  VIEW_RECOVERY_BYTES,
  readAgentViewPerformanceWindow,
  type AgentViewPerformanceWindow,
  type AppearanceSpec,
} from "@claude-bot/web-trust/frame-protocol";

export {
  type AgentViewClient,
  type AgentViewDraftSnapshot,
  type AgentViewDraftStore,
  type AgentViewOperation,
  type AgentViewSnapshot,
  type PendingProposal,
  type Projection,
  type ProposalPhase,
  type ProposalReply,
  type TransportPhase,
} from "./client.js";
export { AgentViewContext, type AgentViewContextValue } from "./context.js";
export { AgentViewProvider, type AgentViewProviderProps } from "./provider.js";
export {
  useAgentView,
  useAgentViewSnapshot,
  useAgentViewStatus,
  useOperations,
  useProjection,
  useProposals,
  usePropose,
  useRefusal,
  useWake,
  type AgentViewStatus,
  type ProposalLedger,
  type Refusal,
} from "./hooks.js";
/**
 * The failure surface. It is in the ROOT entry, not `./ui`, because it reads
 * the proposal ledger and the operation stream — the two things only the App
 * that owns the channel can see. A module cannot mount it, which is correct:
 * "every failure in this View is visible" is a statement about the whole View.
 */
export {
  AgentViewAlerts,
  useAgentViewAlerts,
  type AgentViewAlert,
  type AgentViewAlertsProps,
} from "./alerts.js";
export { AgentViewErrorBoundary, type AgentViewErrorBoundaryProps } from "./ErrorBoundary.js";
export {
  AvButton,
  AvCheckbox,
  AvInput,
  AvTextArea,
  AvTooltip,
  type AvButtonProps,
  type AvButtonTone,
} from "./controls.js";
export { AgentViewUiProvider, agentViewAntTheme } from "./AgentViewUiProvider.js";

export {
  Banner,
  EmptyState,
  Markdown,
  ModalDialog,
  SplitHandle,
  StatusChip,
  type BannerProps,
  type EmptyStateProps,
  type MarkdownProps,
  type ModalDialogProps,
  type SplitHandleProps,
  type StatusChipProps,
  type Tone,
} from "./ui.js";

export { createAppRuntimeClient, type AppRuntimeClient, type AppRuntimeOptions, type AppRuntimeReply } from "./runtime.js";
