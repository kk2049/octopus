import type { ChatSendReceipt } from "@claude-bot/chat-ui-commons/transcript-ui";
import type { TicketWindow } from "../../lib/ticket-session.js";
import { actorKindLabel, isNonPersonActor } from "../../lib/actor-kind.js";

export interface TicketMessage {
  id: number;
  author: string;
  via?: string;
  /** How the row was written (server v86); absent/null = older row, unknown. */
  actor_kind?: string | null;
  body: string;
  created_at?: string;
  delivered_turn?: number | null;
  delivery_state?: "sending" | "delivered" | "failed" | "unknown" | null;
  delivery_error?: string | null;
  delivery_input?: string | null;
}

export interface TicketSendEcho extends ChatSendReceipt {
  key: number;
  ticketId: number;
  messageId?: number;
  source?: TicketMessage;
  /** Exclusive absolute log end at the send gesture, never a list index. */
  after: number;
  created_at: string;
}

/** Person-named rows known not to be that person's own typing (review 6.10). */
function delegated(row: TicketMessage): boolean {
  return row.author !== "agent" && row.author !== "pipeline" && isNonPersonActor(row.actor_kind);
}

/**
 * The exact frame the bot's `formatInbox` puts before each inbox row in the
 * agent prompt (`packages/bot/src/devpipe/prompts.ts#inboxAuthorFrame`). The
 * receipt matcher must build the same string or a delivered row would be
 * shown twice.
 */
export function inboxFrame(row: TicketMessage): string {
  return `[${row.author} via ${row.via}${delegated(row) ? `, actor_kind=${row.actor_kind}` : ""}]`;
}

export function messageReceipt(message: TicketMessage): ChatSendReceipt {
  let input: ChatSendReceipt["input"];
  try {
    const parsed = message.delivery_input ? JSON.parse(message.delivery_input) : null;
    if (["dispatched", "local_queued", "provider_accepted", "input_observed"].includes(parsed?.phase)) input = parsed;
  } catch { /* Legacy messages have no structured input evidence. */ }
  const accepted = input?.phase === "provider_accepted" || input?.phase === "input_observed";
  return {
    prompt: message.body,
    author: message.author
      ? `${message.author}${message.via ? ` via ${message.via}` : ""}${delegated(message) ? ` · ${actorKindLabel(message.actor_kind)}` : ""}`
      : undefined,
    input,
    phase: message.delivery_state === "failed" ? "failed"
      : accepted ? "done"
      : message.delivery_state === "unknown" ? "uncertain"
      : input || message.delivery_state === "sending" ? "running"
      : message.delivered_turn == null ? "submitted" : "done",
    message: message.delivery_error ?? "",
  };
}

interface ReceiptRow {
  key: string;
  receipt: ChatSendReceipt;
  echo?: number;
}

/**
 * Display-only reconciliation. No sending, polling or mutation of the log.
 * Server ids join local echoes to inbox rows; a full user-text occurrence in
 * the log retires each row once. Timestamps (or a local absolute frontier)
 * prevent an old identical prompt from consuming a new send. A batched inbox
 * prompt may contain several distinct occurrences in a single log message.
 */
export function ticketChatReceipts(messages: readonly TicketMessage[], echoes: readonly TicketSendEcho[], win: TicketWindow): {
  rows: ReceiptRow[];
  observedEchoes: number[];
} {
  const humans = messages.filter((row) => row.author !== "agent" && row.author !== "pipeline").sort((a, b) => a.id - b.id);
  const users = win.messages.flatMap((message, index) => {
    if (message.role !== "user") return [];
    const text = message.blocks?.length
      ? message.blocks.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n").trim()
      : message.text?.trim() ?? "";
    return [{ text, at: Date.parse(message.timestamp ?? ""), absolute: win.offset + index }];
  });
  const used = new Set<string>();
  const observed = new Set<number>();
  const observedEchoes: number[] = [];
  const matches = (row: TicketMessage, echo?: TicketSendEcho): boolean => {
    const created = Date.parse(row.created_at ?? echo?.created_at ?? "");
    for (const user of [...users].reverse()) {
      if (echo && user.absolute < echo.after) continue;
      if (Number.isFinite(created) && Number.isFinite(user.at)) {
        if (user.at < created) continue;
      } else if (!echo) continue; // No temporal evidence: keep the fallback.
      const framed = `${inboxFrame(row)}: ${row.body}`;
      const plain = user.text === row.body.trim();
      for (let start = plain ? 0 : user.text.indexOf(framed); start >= 0;
        start = plain ? -1 : user.text.indexOf(framed, start + framed.length)) {
        const end = start + (plain ? user.text.length : framed.length);
        if ((start > 0 && user.text[start - 1] !== "\n")
          || (end < user.text.length && user.text[end] !== "\n")) continue;
        const occurrence = `${user.absolute}:${start}`;
        if (used.has(occurrence)) continue;
        used.add(occurrence);
        return true;
      }
    }
    return false;
  };
  // Most recent rows claim the most recent occurrences, including after a
  // window starts midway through a long history of repeated short prompts.
  for (const row of [...humans].reverse()) {
    const echo = echoes.find((entry) => entry.messageId === row.id);
    if (matches(row, echo)) {
      observed.add(row.id);
      if (echo) observedEchoes.push(echo.key);
    }
  }
  const firstAt = win.messages.map((message) => Date.parse(message.timestamp ?? "")).find(Number.isFinite);
  const rows: ReceiptRow[] = humans.flatMap((row) => {
    if (observed.has(row.id)) return [];
    const echo = echoes.find((entry) => entry.messageId === row.id);
    const current = messageReceipt(row);
    const receipt = echo?.phase === "done" && current.phase !== "failed" ? echo : current;
    // Old accepted inbox history is already owned by the paged transcript.
    // Recent accepted rows remain readable while that log catches up; their
    // settled receipt stops the animation immediately on provider acceptance.
    if (receipt.phase === "done" && !echo && win.messages.length
      && !(firstAt !== undefined && Date.parse(row.created_at ?? "") >= firstAt)) return [];
    return [{ key: echo ? `echo:${echo.key}` : `message:${row.id}`, receipt, echo: echo?.key }];
  });
  for (const echo of echoes) {
    if (humans.some((row) => row.id === echo.messageId)) continue;
    const row: TicketMessage = echo.source ?? { id: echo.messageId ?? -1, author: "", body: echo.prompt, created_at: echo.created_at };
    // A missing HTTP acknowledgement is uncertain; textual coincidence alone
    // must not silently declare that request accepted.
    if (echo.messageId !== undefined && matches(row, echo)) observedEchoes.push(echo.key);
    else rows.push({ key: `echo:${echo.key}`, receipt: echo, echo: echo.key });
  }
  return { rows, observedEchoes };
}
