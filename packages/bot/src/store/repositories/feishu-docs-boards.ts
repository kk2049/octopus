import type Database from "better-sqlite3";

/**
 * A board: static HTML an owner's agent keeps in one Feishu Docs card.
 *
 * `id` is the owner-side handle an agent updates the board by. The card's
 * Record holds a separate capability; `capability` is its SHA-256, so a
 * reader's handle never doubles as the right to change the board.
 */
export interface FeishuDocsBoard {
  id: string;
  capability: string;
  owner: string;
  title: string;
  html: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  revokedAt: number | null;
}

interface Row {
  id: string; capability: string; owner: string; title: string; html: string; version: number;
  created_at: number; updated_at: number; revoked_at: number | null;
}
const board = (row: Row): FeishuDocsBoard => ({
  id: row.id, capability: row.capability, owner: row.owner, title: row.title, html: row.html, version: row.version,
  createdAt: row.created_at, updatedAt: row.updated_at, revokedAt: row.revoked_at,
});

export class FeishuDocsBoardsRepository {
  constructor(private readonly db: Database.Database) {}

  create(row: Omit<FeishuDocsBoard, "version" | "updatedAt" | "revokedAt">): void {
    this.db.prepare("INSERT INTO feishu_docs_boards (id, capability, owner, title, html, version, created_at, updated_at, revoked_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, NULL)")
      .run(row.id, row.capability, row.owner, row.title, row.html, row.createdAt, row.createdAt);
  }

  get(id: string): FeishuDocsBoard | null {
    const row = this.db.prepare("SELECT * FROM feishu_docs_boards WHERE id = ?").get(id) as Row | undefined;
    return row ? board(row) : null;
  }

  byCapability(capability: string): FeishuDocsBoard | null {
    const row = this.db.prepare("SELECT * FROM feishu_docs_boards WHERE capability = ?").get(capability) as Row | undefined;
    return row ? board(row) : null;
  }

  /** Replaces a live board's content; returns the new version, or null when it is not the owner's live board. */
  update(owner: string, id: string, content: { title: string; html: string }, at: number): number | null {
    const changed = this.db.prepare("UPDATE feishu_docs_boards SET title = ?, html = ?, version = version + 1, updated_at = ? WHERE id = ? AND owner = ? AND revoked_at IS NULL")
      .run(content.title, content.html, at, id, owner).changes;
    return changed ? (this.get(id)?.version ?? null) : null;
  }

  /** Ends the owner's live board; true when it was live. */
  revoke(owner: string, id: string, at: number): boolean {
    return this.db.prepare("UPDATE feishu_docs_boards SET revoked_at = ? WHERE id = ? AND owner = ? AND revoked_at IS NULL").run(at, id, owner).changes > 0;
  }
}
