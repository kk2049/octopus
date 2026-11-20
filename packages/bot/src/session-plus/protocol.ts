/**
 * The Session Plus boundary vocabulary, re-exported from its shared home.
 *
 * The constants moved to `@claude-bot/web-trust/frame-protocol` when the trusted
 * half of the transport became part of the Dashboard's React bundle: both sides
 * of the boundary must import ONE definition, and after the move one of those
 * sides is a browser bundle that cannot import from this package. This file
 * stays so every existing import path keeps working and so the vocabulary still
 * has an obvious name inside `session-plus/`.
 */

export {
  MSG,
  PORT_MESSAGE_BYTES,
  PORT_WINDOW_MESSAGES,
  PORT_WINDOW_MS,
  READY_TIMEOUT_MS,
  SESSION_PLUS_PROTOCOL,
  VIEW_HELLO,
  VIEW_RECONNECT,
  WAKE_DEBOUNCE_MS,
  WAKE_WINDOW_MESSAGES,
} from "@claude-bot/web-trust/frame-protocol";
