/**
 * `@claude-bot/agent-view-react/ui` — presentation only, and provably so.
 *
 * ── Why this subpath exists ─────────────────────────────────────────────────
 *
 * A reusable View MODULE (a chat, a roster, a file viewer) needs the design
 * language and the containment primitives. It must not need — and must not be
 * able to reach — the transport: `SESSION_PLUS_PROTOCOL`, `VIEW_HELLO`, the
 * client, or the hooks that carry the Host's answers. Those belong to the App
 * that owns the channel, because the App is the thing that has exactly one.
 *
 * A rule in a review document would express that. An entry point ENFORCES it:
 * a module importing `@claude-bot/agent-view-react/ui` cannot name a wire
 * constant, because the names are not in scope. The dependency boundary becomes
 * a type error rather than a lint someone can silence.
 *
 * Importing this also installs the token stylesheet, so a module that renders a
 * `<StatusChip>` looks right in both colour schemes without the App remembering
 * a second import.
 *
 * `documentStyleNonce` is here for the same reason the stylesheet is: it is
 * about how this document's STYLES are allowed to exist. A module that embeds a
 * library which injects its own `<style>` at run time needs it, or the frame's
 * `style-src 'nonce-…'` drops those styles silently — and only in a real
 * browser. It carries no authority and no identity; see `nonce.ts`.
 */

export {
  Banner,
  DownloadAction,
  DownloadEmptyState,
  DownloadNotice,
  EmptyState,
  Markdown,
  MARKDOWN_RENDER_BUDGET_CHARS,
  useBrowserDownload,
  ModalDialog,
  SplitHandle,
  StatusChip,
  type BannerProps,
  type BrowserDownloadDocument,
  type BrowserDownloadPreparation,
  type BrowserDownloadState,
  type EmptyStateProps,
  type MarkdownProps,
  type ModalDialogProps,
  type SplitHandleProps,
  type StatusChipProps,
  type Tone,
} from "./ui.js";

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

export { adoptDocumentStyles, documentStyleNonce, resetAdoptedDocumentStylesForTests } from "./nonce.js";
