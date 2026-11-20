import type Database from "better-sqlite3";

export interface SharedWorkspace { device: string; workspaceId: string; label: string }
export interface SessionShareRecord {
  id: string;
  owner: string;
  secretHash: string;
  resource: string;
  title: string;
  session: Record<string, unknown>;
  workspaces: SharedWorkspace[];
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
  tokenLimit: number;
  tokensUsed: number;
  /** Durable cumulative high-water mark for one guest-initiated turn. */
  meter: { baseline: number; observed: number; startedAt: number; operationId?: string } | null;
}
export interface ShareRequest {
  id: number; shareId: string; requester: string; kind: "budget" | "lease";
  status: "pending" | "approved" | "denied"; createdAt: number; resolvedAt: number | null;
}

/** One database transaction for every read/modify/write and duplicate request check. */
export class SessionSharesRepository {
  constructor(private readonly db: Database.Database) {}
  get(id: string): SessionShareRecord | null {
    const row = this.db.prepare("SELECT record FROM session_shares WHERE id = ?").get(id) as { record: string } | undefined;
    return row ? JSON.parse(row.record) as SessionShareRecord : null;
  }
  bySecret(hash: string): SessionShareRecord | null {
    const row = this.db.prepare("SELECT id FROM session_shares WHERE secret_hash = ?").get(hash) as { id: string } | undefined;
    return row ? this.get(row.id) : null;
  }
  put(row: SessionShareRecord): void {
    this.db.prepare("INSERT INTO session_shares (id, owner, secret_hash, record) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET record = excluded.record")
      .run(row.id, row.owner, row.secretHash, JSON.stringify(row));
  }
  update(id: string, change: (row: SessionShareRecord) => void): SessionShareRecord {
    return this.db.transaction(() => {
      const row = this.get(id);
      if (!row) throw new Error("共享不存在");
      change(row); this.put(row); return row;
    })();
  }
  join(id: string, viewer: string): void {
    this.db.prepare("INSERT OR IGNORE INTO session_share_members (share_id, viewer) VALUES (?, ?)").run(id, viewer);
  }
  member(id: string, viewer: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM session_share_members WHERE share_id = ? AND viewer = ?").get(id, viewer));
  }
  list(viewer: string): SessionShareRecord[] {
    const rows = this.db.prepare("SELECT record FROM session_shares s WHERE owner = ? OR EXISTS (SELECT 1 FROM session_share_members m WHERE m.share_id = s.id AND m.viewer = ?) ORDER BY rowid DESC LIMIT 200").all(viewer, viewer) as { record: string }[];
    return rows.map((r) => JSON.parse(r.record) as SessionShareRecord);
  }
  pendingMeters(): SessionShareRecord[] {
    return (this.db.prepare("SELECT record FROM session_shares WHERE json_extract(record, '$.meter') IS NOT NULL").all() as { record: string }[]).map((r) => JSON.parse(r.record) as SessionShareRecord);
  }
  /**
   * Settle one metered turn exactly once per completion event. `tokens` null
   * means the turn ended without authenticated accounting (a failed turn): the
   * provisional charge already projected from the transcript stands and the
   * lock is released.
   */
  settle(id: string, eventKey: string, tokens: number | null, completedAt: string): void {
    this.db.transaction(() => {
      const inserted = this.db.prepare("INSERT OR IGNORE INTO session_share_usage_events (event_key, share_id, tokens, completed_at) VALUES (?, ?, ?, ?)").run(eventKey, id, tokens ?? 0, completedAt);
      if (!inserted.changes) return;
      this.update(id, (row) => {
        if (!row.meter) return;
        if (tokens !== null) row.tokensUsed += tokens - Math.max(0, row.meter.observed - row.meter.baseline);
        row.meter = null;
      });
    })();
  }
  request(id: string, requester: string, kind: ShareRequest["kind"], now: number): void {
    this.db.prepare("INSERT OR IGNORE INTO session_share_requests (share_id, requester, kind, status, created_at) VALUES (?, ?, ?, 'pending', ?)").run(id, requester, kind, now);
  }
  requests(owner: string): ShareRequest[] {
    return this.db.prepare("SELECT r.id, r.share_id AS shareId, r.requester, r.kind, r.status, r.created_at AS createdAt, r.resolved_at AS resolvedAt FROM session_share_requests r JOIN session_shares s ON s.id = r.share_id WHERE s.owner = ? ORDER BY r.id DESC LIMIT 200").all(owner) as ShareRequest[];
  }
  decide(owner: string, requestId: number, approve: boolean, now: number, change: (row: SessionShareRecord, kind: ShareRequest["kind"]) => void): void {
    this.db.transaction(() => {
      const request = this.requests(owner).find((r) => r.id === requestId && r.status === "pending");
      if (!request) throw new Error("申请不存在或已处理");
      if (approve) this.update(request.shareId, (row) => change(row, request.kind));
      this.db.prepare("UPDATE session_share_requests SET status = ?, resolved_at = ? WHERE id = ? AND status = 'pending'").run(approve ? "approved" : "denied", now, requestId);
    })();
  }
}
