import type Database from "better-sqlite3";

/**
 * Feishu document share links (migration 93): an owner lets a collaborator's
 * agent read, or read and write, one docx through `/api/mcp`, as the Octopus
 * Feishu app. Each share hangs off an anchor: the Octopus control card in that
 * document. Only SHA-256 digests of the card's capability and of the share's
 * MCP token are stored here. A share the owner's agent creates starts
 * `pending`, with no token; it gets one, once, when its owner reveals it on
 * the card. A reader's own key (migration 94) is inserted active, its token
 * minted in the same transaction.
 */
export type DocShareRights = "read" | "write";
export type DocShareStatus = "pending" | "active" | "paused" | "terminated";
export type DocShareCardState = "present" | "missing" | "unknown";
/** The most a reader may take for themselves on a card; 'off': only the owner makes keys. */
export type DocShareSelfServe = "off" | DocShareRights;
/**
 * How a key was made: by the owner, by a reader on the card, or through the
 * card's claim link. 'assistant' is a document assistant's own share
 * (`feishu/doc-assistants.ts`): it answers only to that assistant's live
 * session scope, never to a token, and is not one of the card's keys.
 */
export type DocShareVia = "owner" | "card" | "invite" | "assistant";

export interface DocShareAnchor {
  id: string;
  owner: string;
  documentId: string;
  /** The wiki node holding the document, when it lives in a wiki: with documentId, its canonical identity, fixed at creation. */
  wikiToken: string | null;
  /** SHA-256 (hex) of the `dsa_` capability the card's Record carries. */
  capabilityHash: string;
  /** Where the card was last seen; null until a sighting. */
  blockId: string | null;
  /** Epoch ms until which the last sighting vouches for the card. */
  leaseUntil: number;
  state: DocShareCardState;
  createdAt: number;
  checkedAt: number | null;
  selfServe: DocShareSelfServe;
  /** SHA-256 (hex) of the card's claim link secret while a link is live, and when it was made. */
  inviteHash: string | null;
  inviteCreatedAt: number | null;
}

export interface DocShare {
  id: string;
  anchorId: string;
  owner: string;
  documentId: string;
  label: string;
  rights: DocShareRights;
  status: DocShareStatus;
  /** SHA-256 of the share's MCP token, the `mcp_tokens` row it authenticates with; null until it is revealed. */
  mcpTokenHash: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  statusChangedAt: number;
  /**
   * Its MCP token row still exists unrevoked. A token revoked from the
   * Dashboard's token list, or deleted with its account, ends the share as
   * surely as terminating it.
   */
  tokenLive: boolean;
  via: DocShareVia;
  /** The Feishu open_id of the signed-in reader who took it; null otherwise. A label, never authority. */
  mintedBy: string | null;
}

/** Shares one list answers at most; newest first. */
const LIST_LIMIT = 200;

interface AnchorRow {
  id: string; owner: string; document_id: string; wiki_token: string | null; capability_hash: string; block_id: string | null;
  lease_until: number; state: DocShareCardState; created_at: number; checked_at: number | null;
  self_serve: DocShareSelfServe; invite_hash: string | null; invite_created_at: number | null;
}
interface ShareRow {
  id: string; anchor_id: string; owner: string; document_id: string; label: string; rights: DocShareRights; status: DocShareStatus;
  mcp_token_hash: string | null; created_at: number; last_used_at: number | null; status_changed_at: number; token_live: number;
  via: DocShareVia; minted_by: string | null;
}
const anchor = (row: AnchorRow): DocShareAnchor => ({
  id: row.id, owner: row.owner, documentId: row.document_id, wikiToken: row.wiki_token, capabilityHash: row.capability_hash, blockId: row.block_id,
  leaseUntil: row.lease_until, state: row.state, createdAt: row.created_at, checkedAt: row.checked_at,
  selfServe: row.self_serve, inviteHash: row.invite_hash, inviteCreatedAt: row.invite_created_at,
});
const share = (row: ShareRow): DocShare => ({
  id: row.id, anchorId: row.anchor_id, owner: row.owner, documentId: row.document_id, label: row.label, rights: row.rights, status: row.status,
  mcpTokenHash: row.mcp_token_hash, createdAt: row.created_at, lastUsedAt: row.last_used_at, statusChangedAt: row.status_changed_at,
  tokenLive: row.token_live === 1, via: row.via, mintedBy: row.minted_by,
});
const SHARES = `SELECT s.*, (t.token_hash IS NOT NULL AND t.revoked_at IS NULL) AS token_live
  FROM feishu_doc_shares s LEFT JOIN mcp_tokens t ON t.token_hash = s.mcp_token_hash`;

export class FeishuDocShareLinksRepository {
  constructor(private readonly db: Database.Database) {}

  /** A card about to be inserted: unknown until Feishu answers or a check finds it. */
  createAnchor(row: Pick<DocShareAnchor, "id" | "owner" | "documentId" | "wikiToken" | "capabilityHash" | "createdAt">): void {
    this.db.prepare(`INSERT INTO feishu_doc_share_anchors (id, owner, document_id, wiki_token, capability_hash, block_id, lease_until, state, created_at, checked_at)
      VALUES (?, ?, ?, ?, ?, NULL, 0, 'unknown', ?, NULL)`).run(row.id, row.owner, row.documentId, row.wikiToken, row.capabilityHash, row.createdAt);
  }

  anchor(id: string): DocShareAnchor | null {
    const row = this.db.prepare("SELECT * FROM feishu_doc_share_anchors WHERE id = ?").get(id) as AnchorRow | undefined;
    return row ? anchor(row) : null;
  }

  anchorByCapability(capabilityHash: string): DocShareAnchor | null {
    const row = this.db.prepare("SELECT * FROM feishu_doc_share_anchors WHERE capability_hash = ?").get(capabilityHash) as AnchorRow | undefined;
    return row ? anchor(row) : null;
  }

  /** The card whose live claim link hashes to `inviteHash`. */
  anchorByInvite(inviteHash: string): DocShareAnchor | null {
    const row = this.db.prepare("SELECT * FROM feishu_doc_share_anchors WHERE invite_hash = ?").get(inviteHash) as AnchorRow | undefined;
    return row ? anchor(row) : null;
  }

  /** The owner's newest card in this document not known to be gone (present, or never settled). */
  liveAnchor(owner: string, documentId: string): DocShareAnchor | null {
    const row = this.db.prepare(`SELECT * FROM feishu_doc_share_anchors WHERE owner = ? AND document_id = ? AND state <> 'missing'
      ORDER BY created_at DESC, id DESC LIMIT 1`).get(owner, documentId) as AnchorRow | undefined;
    return row ? anchor(row) : null;
  }

  /** The card was seen at `blockId` at `at`; the sighting vouches for it until `leaseUntil`. */
  markPresent(id: string, blockId: string, leaseUntil: number, at: number): void {
    this.db.prepare("UPDATE feishu_doc_share_anchors SET state = 'present', block_id = ?, lease_until = ?, checked_at = ? WHERE id = ?")
      .run(blockId, leaseUntil, at, id);
  }

  /** A check at `at` read the whole document and did not find the card. */
  markMissing(id: string, at: number): void {
    this.db.prepare("UPDATE feishu_doc_share_anchors SET state = 'missing', checked_at = ? WHERE id = ?").run(at, id);
  }

  /** The most readers may take for themselves on this card. */
  setSelfServe(id: string, selfServe: DocShareSelfServe): void {
    this.db.prepare("UPDATE feishu_doc_share_anchors SET self_serve = ? WHERE id = ?").run(selfServe, id);
  }

  /** The card's claim link: a new one (whatever link it had stops at once), or none. */
  setInvite(id: string, invite: { hash: string; at: number } | null): void {
    this.db.prepare("UPDATE feishu_doc_share_anchors SET invite_hash = ?, invite_created_at = ? WHERE id = ?")
      .run(invite?.hash ?? null, invite?.at ?? null, id);
  }

  /** A new share from the owner's agent: pending, with no token until its owner reveals it on the card. */
  createShare(row: Omit<DocShare, "status" | "mcpTokenHash" | "lastUsedAt" | "statusChangedAt" | "tokenLive" | "via" | "mintedBy">): void {
    this.db.prepare(`INSERT INTO feishu_doc_shares (id, anchor_id, owner, document_id, label, rights, status, mcp_token_hash, created_at, last_used_at, status_changed_at, via, minted_by)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL, ?, 'owner', NULL)`)
      .run(row.id, row.anchorId, row.owner, row.documentId, row.label, row.rights, row.createdAt, row.createdAt);
  }

  /** A reader's own key: active from the start, with the hash of the token the caller mints in the same transaction. */
  createActiveShare(row: Omit<DocShare, "status" | "lastUsedAt" | "statusChangedAt" | "tokenLive" | "via" | "mcpTokenHash">
    & { via: "card" | "invite"; mcpTokenHash: string }): void {
    this.db.prepare(`INSERT INTO feishu_doc_shares (id, anchor_id, owner, document_id, label, rights, status, mcp_token_hash, created_at, last_used_at, status_changed_at, via, minted_by)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, ?, ?, ?)`)
      .run(row.id, row.anchorId, row.owner, row.documentId, row.label, row.rights, row.mcpTokenHash, row.createdAt, row.createdAt, row.via, row.mintedBy);
  }

  /** The reveal: a pending share takes its token and turns active; false when it was not pending. */
  activate(owner: string, id: string, mcpTokenHash: string, at: number): boolean {
    return this.db.prepare(`UPDATE feishu_doc_shares SET status = 'active', mcp_token_hash = ?, status_changed_at = ?
      WHERE owner = ? AND id = ? AND status = 'pending'`).run(mcpTokenHash, at, owner, id).changes > 0;
  }

  share(id: string): DocShare | null {
    const row = this.db.prepare(`${SHARES} WHERE s.id = ?`).get(id) as ShareRow | undefined;
    return row ? share(row) : null;
  }

  /** The owner's shares, of one document or of all; newest first, at most LIST_LIMIT. */
  ownedShares(owner: string, documentId?: string): DocShare[] {
    const rows = documentId === undefined
      ? this.db.prepare(`${SHARES} WHERE s.owner = ? ORDER BY s.created_at DESC, s.id DESC LIMIT ?`).all(owner, LIST_LIMIT)
      : this.db.prepare(`${SHARES} WHERE s.owner = ? AND s.document_id = ? ORDER BY s.created_at DESC, s.id DESC LIMIT ?`).all(owner, documentId, LIST_LIMIT);
    return (rows as ShareRow[]).map(share);
  }

  /** The keys one card lists (a document assistant's share is not one); newest first, at most LIST_LIMIT. */
  anchorShares(anchorId: string): DocShare[] {
    return (this.db.prepare(`${SHARES} WHERE s.anchor_id = ? AND s.via <> 'assistant' ORDER BY s.created_at DESC, s.id DESC LIMIT ?`).all(anchorId, LIST_LIMIT) as ShareRow[]).map(share);
  }

  /** Keys readers took for themselves on this card (on it, or through its claim link) after `since`, whatever became of them. */
  selfServedSince(anchorId: string, since: number): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM feishu_doc_shares WHERE anchor_id = ? AND via IN ('card', 'invite') AND created_at > ?`)
      .get(anchorId, since) as { n: number }).n;
  }

  /**
   * The card's keys not ended, whoever made them: pending, or active or paused on a live token (as `shareStatus` reads them).
   * Document assistants' shares are not keys: they have limits of their own (`doc-assistants.ts`).
   */
  liveShareCount(anchorId: string): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM feishu_doc_shares s LEFT JOIN mcp_tokens t ON t.token_hash = s.mcp_token_hash
      WHERE s.anchor_id = ? AND s.via <> 'assistant'
        AND (s.status = 'pending' OR (s.status IN ('active', 'paused') AND t.token_hash IS NOT NULL AND t.revoked_at IS NULL))`)
      .get(anchorId) as { n: number }).n;
  }

  /**
   * Moves the owner's share from one of `from` to `to`; false when it was in
   * none of them. Nothing leaves `terminated`, and nothing enters `pending`
   * (triggers enforce both); a pending share turns active only by `activate`.
   */
  transition(owner: string, id: string, from: readonly DocShareStatus[], to: DocShareStatus, at: number): boolean {
    const allowed = from.filter((status) => status !== "terminated");
    if (!allowed.length) return false;
    return this.db.prepare(`UPDATE feishu_doc_shares SET status = ?, status_changed_at = ?
      WHERE owner = ? AND id = ? AND status IN (${allowed.map(() => "?").join(", ")})`).run(to, at, owner, id, ...allowed).changes > 0;
  }

  touch(id: string, at: number): void {
    this.db.prepare("UPDATE feishu_doc_shares SET last_used_at = ? WHERE id = ?").run(at, id);
  }

  /** A document assistant's share: via 'assistant', active at once with its token's hash (written in the caller's transaction). */
  createAssistantShare(row: Pick<DocShare, "id" | "anchorId" | "owner" | "documentId" | "label" | "rights" | "createdAt"> & { mcpTokenHash: string }): void {
    this.db.prepare(`INSERT INTO feishu_doc_shares (id, anchor_id, owner, document_id, label, rights, status, mcp_token_hash, created_at, last_used_at, status_changed_at, via, minted_by)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, ?, 'assistant', NULL)`)
      .run(row.id, row.anchorId, row.owner, row.documentId, row.label, row.rights, row.mcpTokenHash, row.createdAt, row.createdAt);
  }
}
