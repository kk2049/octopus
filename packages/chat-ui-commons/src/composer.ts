/**
 * One responsive keyboard contract for chat composers in trusted pages and
 * isolated Agent Views. The caller still owns the draft and the side effect;
 * this module only decides whether this key press means "submit".
 */

export const COMPACT_CHAT_MEDIA_QUERY = "(max-width: 720px)";

export interface ChatComposerKeyEvent {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: {
    isComposing?: boolean;
    keyCode?: number;
  };
  preventDefault(): void;
}

export interface ChatViewportTarget {
  matchMedia(query: string): { matches: boolean };
}

function browserViewport(): ChatViewportTarget | undefined {
  const candidate = globalThis as typeof globalThis & Partial<ChatViewportTarget>;
  return typeof candidate.matchMedia === "function" ? candidate as ChatViewportTarget : undefined;
}

export function isCompactChatViewport(target = browserViewport()): boolean {
  return target?.matchMedia(COMPACT_CHAT_MEDIA_QUERY).matches ?? false;
}

/**
 * Compact layouts send on Enter. Wide layouts preserve multi-line editing and
 * require Ctrl/Command+Enter. IME confirmation and held-key repeats never send.
 */
export function shouldSubmitChatKey(event: ChatComposerKeyEvent, compact: boolean): boolean {
  const composing = event.isComposing
    || event.nativeEvent?.isComposing
    // WebKit can report the IME composition sentinel without isComposing.
    || event.keyCode === 229
    || event.nativeEvent?.keyCode === 229;
  if (event.key !== "Enter" || event.repeat || composing) return false;
  return compact || Boolean(event.ctrlKey || event.metaKey);
}

/**
 * Returns true when the key was consumed as a submit gesture.
 *
 * This is the RESPONSIVE policy, and it belongs to a live agent chat: there the
 * unit of input is one short message, so Enter-sends on a phone is worth losing
 * newline entry for.
 */
export function handleChatComposerKeyDown(
  event: ChatComposerKeyEvent,
  submit: () => void,
  target?: ChatViewportTarget,
): boolean {
  if (!shouldSubmitChatKey(event, isCompactChatViewport(target))) return false;
  event.preventDefault();
  submit();
  return true;
}

/**
 * The other policy: Enter always inserts a newline, on every viewport, and only
 * Ctrl/Command+Enter submits.
 *
 * Ticket #180. Composers whose unit of input is a whole brief — a ticket body,
 * a discussion opener, a steering message on a ticket — were sharing the
 * responsive policy, so on a phone the first paragraph break sent the form.
 * That is unrecoverable in a way a chat message is not: the text is gone from
 * the box and a ticket (or an agent turn) already exists. Multi-line editing is
 * the requirement here, so the submit gesture stays explicit everywhere.
 */
export function handleModifierSubmitKeyDown(
  event: ChatComposerKeyEvent,
  submit: () => void,
): boolean {
  if (!shouldSubmitChatKey(event, false)) return false;
  event.preventDefault();
  submit();
  return true;
}
