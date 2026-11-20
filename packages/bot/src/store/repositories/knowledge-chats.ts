import type Database from "better-sqlite3";

export type KnowledgeChatMessageRole = "user" | "assistant" | "error";

export interface KnowledgeChatRow {
  id: string;
  username: string;
  subject_id: string | null;
  title: string;
  preview: string;
  request_id: string;
  created_at: string;
  updated_at: string;
  running_since: string | null;
}

export interface KnowledgeChatMessageRow {
  id: number;
  chat_id: string;
  role: KnowledgeChatMessageRole;
  content: string;
  request_id: string | null;
  at: string;
}

/** Messages in one history window; older windows are reached by cursor. */
export const KNOWLEDGE_CHAT_PAGE = 400;

/** Conversations in one roster window; older windows are reached by cursor. */
export const KNOWLEDGE_CHAT_LIST_PAGE = 100;

/** A position in the roster's order (`updated_at DESC, id DESC`): the last row of a window. */
export interface KnowledgeChatListCursor {
  updatedAt: string;
  id: string;
}

export type BeginKnowledgeChatTurnResult =
  | { ok: true; duplicate: boolean; chat: KnowledgeChatRow }
  | { ok: false; code: "not_found" | "busy" };

/** Owner-scoped persistence for knowledge conversations; it never touches dev_tickets. */
export class KnowledgeChatsRepository {
  constructor(private readonly db: Database.Database) {}

  create(input: {
    id: string;
    username: string;
    subjectId?: string | null;
    title: string;
    message: string;
    requestId: string;
  }): { chat: KnowledgeChatRow; created: boolean } {
    return this.db.transaction(() => {
      const existing = this.db.prepare(
        "SELECT * FROM knowledge_chats WHERE username = ? AND request_id = ?",
      ).get(input.username, input.requestId) as KnowledgeChatRow | undefined;
      if (existing) return { chat: existing, created: false };

      const at = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO knowledge_chats (
          id, username, subject_id, title, preview, request_id,
          created_at, updated_at, running_since
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id,
        input.username,
        input.subjectId ?? null,
        input.title,
        input.message,
        input.requestId,
        at,
        at,
        at,
      );
      this.db.prepare(`
        INSERT INTO knowledge_chat_messages (chat_id, role, content, request_id, at)
        VALUES (?, 'user', ?, ?, ?)
      `).run(input.id, input.message, input.requestId, at);
      return { chat: this.get(input.username, input.id)!, created: true };
    })();
  }

  /**
   * One roster window, most recently active first. `before` is the previous
   * window's `next` (its last row): a keyset position, so a conversation that
   * becomes active between windows moves to the first window instead of being
   * repeated or skipping another. The roster used to stop at the newest 100.
   */
  list(username: string, options: { before?: KnowledgeChatListCursor; limit?: number } = {}): {
    chats: KnowledgeChatRow[];
    next: KnowledgeChatListCursor | null;
  } {
    const limit = Math.min(Math.max(Math.floor(options.limit ?? KNOWLEDGE_CHAT_LIST_PAGE), 1), KNOWLEDGE_CHAT_LIST_PAGE);
    const before = options.before;
    const rows = (before
      ? this.db.prepare(`
          SELECT * FROM knowledge_chats
          WHERE username = ? AND (updated_at < ? OR (updated_at = ? AND id < ?))
          ORDER BY updated_at DESC, id DESC
          LIMIT ?
        `).all(username, before.updatedAt, before.updatedAt, before.id, limit + 1)
      : this.db.prepare(`
          SELECT * FROM knowledge_chats
          WHERE username = ?
          ORDER BY updated_at DESC, id DESC
          LIMIT ?
        `).all(username, limit + 1)) as KnowledgeChatRow[];
    const chats = rows.slice(0, limit);
    const last = chats.at(-1);
    return { chats, next: rows.length > limit && last ? { updatedAt: last.updated_at, id: last.id } : null };
  }

  get(username: string, id: string): KnowledgeChatRow | undefined {
    return this.db.prepare(
      "SELECT * FROM knowledge_chats WHERE id = ? AND username = ?",
    ).get(id, username) as KnowledgeChatRow | undefined;
  }

  getByCreateRequest(username: string, requestId: string): KnowledgeChatRow | undefined {
    return this.db.prepare(
      "SELECT * FROM knowledge_chats WHERE username = ? AND request_id = ?",
    ).get(username, requestId) as KnowledgeChatRow | undefined;
  }

  getByTurnRequest(username: string, chatId: string, requestId: string): KnowledgeChatRow | undefined {
    return this.db.prepare(`
      SELECT c.*
      FROM knowledge_chats c
      JOIN knowledge_chat_messages m ON m.chat_id = c.id
      WHERE c.username = ? AND c.id = ? AND m.role = 'user' AND m.request_id = ?
    `).get(username, chatId, requestId) as KnowledgeChatRow | undefined;
  }

  /**
   * The whole conversation, oldest first: what the model is replayed. The
   * model's context window is the semantic bound; a row cap here used to drop
   * the NEWEST messages once a chat passed it, so the latest question was
   * never asked.
   */
  messages(username: string, chatId: string): KnowledgeChatMessageRow[] {
    return this.db.prepare(`
      SELECT m.*
      FROM knowledge_chat_messages m
      JOIN knowledge_chats c ON c.id = m.chat_id
      WHERE m.chat_id = ? AND c.username = ?
      ORDER BY m.id
    `).all(chatId, username) as KnowledgeChatMessageRow[];
  }

  /**
   * One display window, oldest first: the newest `limit` messages with an id
   * below `before` (the newest overall without it). `hasEarlier` says an
   * older window exists; its cursor is this window's first id.
   */
  messagePage(username: string, chatId: string, options: { before?: number; limit?: number } = {}): {
    messages: KnowledgeChatMessageRow[];
    hasEarlier: boolean;
  } {
    const limit = Math.min(Math.max(Math.floor(options.limit ?? KNOWLEDGE_CHAT_PAGE), 1), KNOWLEDGE_CHAT_PAGE);
    const before = options.before !== undefined && Number.isSafeInteger(options.before) ? options.before : Number.MAX_SAFE_INTEGER;
    const rows = this.db.prepare(`
      SELECT m.*
      FROM knowledge_chat_messages m
      JOIN knowledge_chats c ON c.id = m.chat_id
      WHERE m.chat_id = ? AND c.username = ? AND m.id < ?
      ORDER BY m.id DESC
      LIMIT ?
    `).all(chatId, username, before, limit + 1) as KnowledgeChatMessageRow[];
    return { messages: rows.slice(0, limit).reverse(), hasEarlier: rows.length > limit };
  }

  beginTurn(input: {
    username: string;
    chatId: string;
    message: string;
    requestId: string;
  }): BeginKnowledgeChatTurnResult {
    return this.db.transaction(() => {
      const chat = this.get(input.username, input.chatId);
      if (!chat) return { ok: false, code: "not_found" } as const;
      const duplicate = this.db.prepare(`
        SELECT id FROM knowledge_chat_messages
        WHERE chat_id = ? AND role = 'user' AND request_id = ?
      `).get(input.chatId, input.requestId) as { id: number } | undefined;
      if (duplicate) return { ok: true, duplicate: true, chat } as const;
      if (chat.running_since) return { ok: false, code: "busy" } as const;

      const at = new Date().toISOString();
      const claimed = this.db.prepare(`
        UPDATE knowledge_chats
        SET running_since = ?, updated_at = ?, preview = ?
        WHERE id = ? AND username = ? AND running_since IS NULL
      `).run(at, at, input.message, input.chatId, input.username);
      if (claimed.changes !== 1) return { ok: false, code: "busy" } as const;
      this.db.prepare(`
        INSERT INTO knowledge_chat_messages (chat_id, role, content, request_id, at)
        VALUES (?, 'user', ?, ?, ?)
      `).run(input.chatId, input.message, input.requestId, at);
      return { ok: true, duplicate: false, chat: this.get(input.username, input.chatId)! } as const;
    })();
  }

  append(chatId: string, role: Exclude<KnowledgeChatMessageRole, "user">, content: string): KnowledgeChatMessageRow {
    const at = new Date().toISOString();
    const result = this.db.prepare(`
      INSERT INTO knowledge_chat_messages (chat_id, role, content, request_id, at)
      VALUES (?, ?, ?, NULL, ?)
    `).run(chatId, role, content, at);
    this.db.prepare("UPDATE knowledge_chats SET updated_at = ? WHERE id = ?").run(at, chatId);
    return { id: Number(result.lastInsertRowid), chat_id: chatId, role, content, request_id: null, at };
  }

  /** Trusted recovery enumeration, not a user-facing account listing. */
  running(): KnowledgeChatRow[] {
    return this.db.prepare("SELECT * FROM knowledge_chats WHERE running_since IS NOT NULL ORDER BY id").all() as KnowledgeChatRow[];
  }

  latestInput(username: string, chatId: string): KnowledgeChatMessageRow | undefined {
    return this.db.prepare(`SELECT m.* FROM knowledge_chat_messages m JOIN knowledge_chats c ON c.id=m.chat_id
      WHERE c.username=? AND c.id=? AND m.role='user' ORDER BY m.id DESC LIMIT 1`)
      .get(username, chatId) as KnowledgeChatMessageRow | undefined;
  }

  appendOnce(chatId: string, role: Exclude<KnowledgeChatMessageRole, "user">, requestId: string, content: string): void {
    this.db.transaction(() => {
      const exists = this.db.prepare("SELECT 1 FROM knowledge_chat_messages WHERE chat_id=? AND request_id=?").get(chatId, requestId);
      if (exists) return;
      const at = new Date().toISOString();
      this.db.prepare("INSERT INTO knowledge_chat_messages (chat_id, role, content, request_id, at) VALUES (?, ?, ?, ?, ?)")
        .run(chatId, role, content, requestId, at);
      this.db.prepare("UPDATE knowledge_chats SET updated_at=? WHERE id=?").run(at, chatId);
    })();
  }

  finishTurn(chatId: string): void {
    this.db.prepare("UPDATE knowledge_chats SET running_since = NULL WHERE id = ?").run(chatId);
  }

  recoverInterruptedTurns(): string[] {
    return this.db.transaction(() => {
      const rows = this.db.prepare(
        "SELECT id FROM knowledge_chats WHERE running_since IS NOT NULL ORDER BY id",
      ).all() as Array<{ id: string }>;
      for (const row of rows) {
        this.append(row.id, "error", "服务重启时上一轮仍在运行，结果无法确认；请检查记录后再重试。");
        this.finishTurn(row.id);
      }
      return rows.map((row) => row.id);
    })();
  }
}
