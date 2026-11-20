import type Database from 'better-sqlite3';
import type { Discussion, DiscussionMessage, DiscussionEvent, DiscussionOutbox } from '../../discussions/types.js';

/** All membership selection happens in SQL before bounded pagination. */
export class DiscussionsRepository {
  constructor(private readonly db: Database.Database) {}
  get(id: string): Discussion | null {
    const row = this.db.prepare('SELECT record FROM discussions WHERE id = ?').get(id) as { record: string } | undefined;
    return row ? JSON.parse(row.record) as Discussion : null;
  }
  forMember(id: string, username: string): Discussion | null {
    const row = this.db.prepare('SELECT d.record FROM discussions d JOIN discussion_members m ON m.discussion_id = d.id WHERE d.id = ? AND m.username = ?').get(id, username) as { record: string } | undefined;
    return row ? JSON.parse(row.record) as Discussion : null;
  }
  byRequest(owner: string, requestId: string): Discussion | null {
    const row = this.db.prepare('SELECT record FROM discussions WHERE owner = ? AND request_id = ?').get(owner, requestId) as { record: string } | undefined;
    return row ? JSON.parse(row.record) as Discussion : null;
  }
  byChat(chatId: string): Discussion | null {
    const row = this.db.prepare('SELECT record FROM discussions WHERE chat_id = ?').get(chatId) as { record: string } | undefined;
    return row ? JSON.parse(row.record) as Discussion : null;
  }
  list(username: string): Discussion[] {
    return (this.db.prepare('SELECT d.record FROM discussions d JOIN discussion_members m ON m.discussion_id = d.id WHERE m.username = ? ORDER BY d.updated_at DESC, d.id LIMIT 100').all(username) as { record: string }[]).map(row => JSON.parse(row.record) as Discussion);
  }
  active(): Discussion[] {
    return (this.db.prepare("SELECT record FROM discussions WHERE status IN ('creating','active','paused') ORDER BY updated_at, id").all() as { record: string }[]).map(row => JSON.parse(row.record) as Discussion);
  }
  create(row: Discussion): void {
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO discussions(id, owner, request_id, chat_id, status, updated_at, record) VALUES (?,?,?,?,?,?,?)').run(row.id, row.owner, row.requestId, row.chatId, row.status, row.updatedAt, JSON.stringify(row));
      const insert = this.db.prepare('INSERT INTO discussion_members(discussion_id, username) VALUES (?,?)');
      for (const member of row.members) insert.run(row.id, member.username);
    })();
  }
  patch(id: string, patch: Partial<Omit<Discussion, 'id' | 'owner' | 'members' | 'requestId' | 'fingerprint'>>): Discussion {
    const current = this.get(id);
    if (!current) throw new Error('会议不存在');
    const row = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.db.prepare('UPDATE discussions SET chat_id = ?, status = ?, updated_at = ?, record = ? WHERE id = ?').run(row.chatId, row.status, row.updatedAt, JSON.stringify(row), id);
    return row;
  }
  append(input: Omit<DiscussionMessage, 'seq' | 'created_at'>): { message: DiscussionMessage; duplicate: boolean } {
    const prior = this.db.prepare('SELECT * FROM discussion_messages WHERE discussion_id = ? AND external_id = ?').get(input.discussion_id, input.external_id) as DiscussionMessage | undefined;
    if (prior) {
      if (prior.text !== input.text || prior.sender !== input.sender) throw new Error('同一消息标识不能用于不同内容');
      return { message: prior, duplicate: true };
    }
    const at = new Date().toISOString();
    const result = this.db.prepare('INSERT INTO discussion_messages(discussion_id, external_id, sender, text, role, triage, reason, created_at) VALUES (?,?,?,?,?,?,?,?)').run(input.discussion_id, input.external_id, input.sender, input.text, input.role, input.triage, input.reason, at);
    return { message: { ...input, seq: Number(result.lastInsertRowid), created_at: at }, duplicate: false };
  }
  messages(id: string, after = 0, limit = 100): DiscussionMessage[] {
    return this.db.prepare('SELECT * FROM discussion_messages WHERE discussion_id = ? AND seq > ? ORDER BY seq LIMIT ?').all(id, after, Math.max(1, Math.min(200, limit))) as DiscussionMessage[];
  }
  recent(id: string, limit = 50): DiscussionMessage[] {
    return (this.db.prepare('SELECT * FROM discussion_messages WHERE discussion_id = ? ORDER BY seq DESC LIMIT ?').all(id, Math.min(200, limit)) as DiscussionMessage[]).reverse();
  }
  before(id: string, seq: number, limit = 8): DiscussionMessage[] {
    return (this.db.prepare('SELECT * FROM discussion_messages WHERE discussion_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?').all(id, seq, Math.max(1, Math.min(200, limit))) as DiscussionMessage[]).reverse();
  }
  pendingFilter(id: string): DiscussionMessage | null {
    return this.db.prepare("SELECT * FROM discussion_messages WHERE discussion_id = ? AND triage = 'pending' ORDER BY seq LIMIT 1").get(id) as DiscussionMessage | undefined ?? null;
  }
  classify(seq: number, wake: boolean, reason: string): void {
    this.db.prepare('UPDATE discussion_messages SET triage = ?, reason = ? WHERE seq = ?').run(wake ? 'wake' : 'quiet', reason.slice(0, 300), seq);
  }
  hasWake(id: string, after: number): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM discussion_messages WHERE discussion_id = ? AND seq > ? AND triage = 'wake' LIMIT 1").get(id, after));
  }
  event(id: string, agent: string, kind: string, text: string): void {
    this.db.prepare('INSERT INTO discussion_events(discussion_id, agent, kind, text, created_at) VALUES (?,?,?,?,?)').run(id, agent, kind, text.slice(0, 8000), new Date().toISOString());
  }
  events(id: string, after = 0): DiscussionEvent[] {
    return this.db.prepare('SELECT * FROM discussion_events WHERE discussion_id = ? AND seq > ? ORDER BY seq LIMIT 100').all(id, after) as DiscussionEvent[];
  }
  recentEvents(id: string): DiscussionEvent[] {
    return (this.db.prepare('SELECT * FROM discussion_events WHERE discussion_id = ? ORDER BY seq DESC LIMIT 80').all(id) as DiscussionEvent[]).reverse();
  }
  enqueue(out: DiscussionOutbox): void {
    this.db.prepare('INSERT INTO discussion_outbox(id, discussion_id, text, status, message_id) VALUES (?,?,?,?,?)').run(out.id, out.discussion_id, out.text, out.status, out.message_id);
  }
  outbox(id: string): DiscussionOutbox[] {
    return this.db.prepare("SELECT * FROM discussion_outbox WHERE discussion_id = ? AND status IN ('pending','sending','unknown') ORDER BY rowid LIMIT 100").all(id) as DiscussionOutbox[];
  }
  delivery(id: string, status: DiscussionOutbox['status'], messageId: string | null = null): void {
    this.db.prepare('UPDATE discussion_outbox SET status = ?, message_id = ? WHERE id = ?').run(status, messageId, id);
  }
  recoverDeliveries(): void {
    this.db.prepare("UPDATE discussion_outbox SET status = 'cancelled' WHERE status = 'pending'").run();
    this.db.prepare("UPDATE discussion_outbox SET status = 'unknown' WHERE status = 'sending'").run();
  }
}
