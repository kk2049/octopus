import type Database from "better-sqlite3";

/**
 * One Feishu Docs Agent card's read-only view of one session.
 *
 * `id` is the SHA-256 of the capability the card keeps in its document Record;
 * the capability itself is never stored. A row grants observation only — input
 * needs the owner's own Feishu login, or a member the owner made a speaker.
 *
 * A live card follows its session. A snapshot card shows the conversation as
 * it stood at one completed turn: its rows are kept here, with the provider's
 * anchor for that turn, so it reads without the device and a fork starts there.
 */
export interface FeishuDocsShare {
  id: string;
  owner: string;
  resource: string;
  title: string;
  createdAt: number;
  revokedAt: number | null;
  /** The newest agent reply (its timestamp) the owner has seen in a card of this session. */
  readAt?: string | null;
  kind?: "live" | "snapshot";
  snapshot?: FeishuDocsSnapshot;
  /** How a snapshot or a fork's card came to be, for the card's subtitle. */
  origin?: FeishuDocsOrigin;
}

export interface FeishuDocsSnapshot {
  /** The completed turn it stands at: Claude message uuid or Codex turn id. */
  anchor: string;
  /** ISO time it was taken. */
  at: string;
  rows: Array<{ i: number; role: "user" | "assistant"; text: string; cut?: number; tools?: string[]; at?: string }>;
}

export interface FeishuDocsOrigin {
  kind: "snapshot" | "fork";
  /** The source card's title. */
  from: string;
  /** Who made it (an Octopus username). */
  by: string;
  at: number;
}

interface Row {
  id: string; owner: string; resource: string; title: string; created_at: number; revoked_at: number | null; read_at?: string | null;
  kind?: string | null; snapshot?: string | null; origin?: string | null;
}
const parse = <T>(value: string | null | undefined): T | undefined => {
  if (!value) return undefined;
  try { return JSON.parse(value) as T; } catch { return undefined; }
};
const share = (row: Row): FeishuDocsShare => {
  const snapshot = row.kind === "snapshot" ? parse<FeishuDocsSnapshot>(row.snapshot) : undefined;
  const origin = parse<FeishuDocsOrigin>(row.origin);
  return {
    id: row.id, owner: row.owner, resource: row.resource, title: row.title, createdAt: row.created_at, revokedAt: row.revoked_at, readAt: row.read_at ?? null,
    kind: snapshot ? "snapshot" : "live", ...(snapshot ? { snapshot } : {}), ...(origin ? { origin } : {}),
  };
};

export class FeishuDocsSharesRepository {
  constructor(private readonly db: Database.Database) {}

  create(row: FeishuDocsShare): void {
    this.db.prepare("INSERT INTO feishu_docs_shares (id, owner, resource, title, created_at, revoked_at, kind, snapshot, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(row.id, row.owner, row.resource, row.title, row.createdAt, row.revokedAt, row.snapshot ? "snapshot" : "live",
        row.snapshot ? JSON.stringify(row.snapshot) : null, row.origin ? JSON.stringify(row.origin) : null);
  }

  get(id: string): FeishuDocsShare | null {
    const row = this.db.prepare("SELECT * FROM feishu_docs_shares WHERE id = ?").get(id) as Row | undefined;
    return row ? share(row) : null;
  }

  /**
   * Revokes the owner's unrevoked share of one card (`id`), or every live card
   * of one session (`resource`); returns what ended. Snapshots of the session
   * are records of a past moment and end only one card at a time.
   */
  revoke(owner: string, target: { id: string } | { resource: string }, at: number): string[] {
    const [where, value] = "id" in target ? ["id = ?", target.id] : ["resource = ? AND kind = 'live'", target.resource];
    return this.db.transaction(() => {
      const ids = (this.db.prepare(`SELECT id FROM feishu_docs_shares WHERE owner = ? AND ${where} AND revoked_at IS NULL`)
        .all(owner, value) as { id: string }[]).map((r) => r.id);
      const end = this.db.prepare("UPDATE feishu_docs_shares SET revoked_at = ? WHERE id = ?");
      for (const id of ids) end.run(at, id);
      return ids;
    })();
  }

  /** The owner has seen the agent's replies up to `at` (an ISO timestamp); never moves backwards. */
  markRead(owner: string, resource: string, at: string): void {
    this.db.prepare("UPDATE feishu_docs_shares SET read_at = ? WHERE owner = ? AND resource = ? AND (read_at IS NULL OR read_at < ?)")
      .run(at, owner, resource, at);
  }

  /** Live card count per session resource, for the owner's session picker. */
  liveCounts(owner: string): Map<string, number> {
    const rows = this.db.prepare("SELECT resource, COUNT(*) AS n FROM feishu_docs_shares WHERE owner = ? AND revoked_at IS NULL AND kind = 'live' GROUP BY resource")
      .all(owner) as { resource: string; n: number }[];
    return new Map(rows.map((r) => [r.resource, r.n]));
  }
}

/**
 * Members an owner lets talk to one of their agents (a session resource) in
 * its cards. The owner always may; a speaker's messages carry their name.
 */
export class FeishuDocsSpeakersRepository {
  constructor(private readonly db: Database.Database) {}

  list(owner: string, resource: string): string[] {
    return (this.db.prepare("SELECT member FROM feishu_docs_speakers WHERE owner = ? AND resource = ? ORDER BY created_at, member")
      .all(owner, resource) as { member: string }[]).map((r) => r.member);
  }

  has(owner: string, resource: string, member: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM feishu_docs_speakers WHERE owner = ? AND resource = ? AND member = ?").get(owner, resource, member));
  }

  /** Makes `members` exactly the speakers of one agent; returns them. */
  replace(owner: string, resource: string, members: readonly string[], at: number): string[] {
    return this.db.transaction(() => {
      this.db.prepare("DELETE FROM feishu_docs_speakers WHERE owner = ? AND resource = ?").run(owner, resource);
      const add = this.db.prepare("INSERT INTO feishu_docs_speakers (owner, resource, member, created_at) VALUES (?, ?, ?, ?)");
      for (const member of new Set(members)) if (member !== owner) add.run(owner, resource, member, at);
      return this.list(owner, resource);
    })();
  }

  add(owner: string, resource: string, member: string, at: number): void {
    if (member === owner) return;
    this.db.prepare("INSERT OR IGNORE INTO feishu_docs_speakers (owner, resource, member, created_at) VALUES (?, ?, ?, ?)").run(owner, resource, member, at);
  }
}
