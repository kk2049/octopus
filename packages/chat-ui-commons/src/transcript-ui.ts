/**
 * Host-neutral chat rendering. This component subpath is side-effect-free;
 * bundle entries opt into the shared structural CSS through the explicit
 * `@claude-bot/chat-ui-commons/transcript-ui.css` export.
 */

export {
  ChatTurn,
  DEFAULT_TRANSCRIPT_COPY,
  TranscriptGroupView,
  renderPlainTextAssistant,
  type ReadFullBlock,
  type TranscriptBlockField,
  type ChatTurnClasses,
  type ChatTurnProps,
  type TranscriptCopy,
  type TranscriptGroupClasses,
  type TranscriptGroupViewProps,
} from "./TranscriptGroup.js";

export {
  ChatScroller,
  ChatTranscript,
  SHARED_CHAT_CLASSES,
  type ChatScrollerProps,
  type ChatTranscriptClasses,
  type ChatTranscriptProps,
} from "./ChatTranscript.js";

export { SendReceipt, sendPhaseWord, type ChatSendReceipt } from "./SendReceipt.js";
