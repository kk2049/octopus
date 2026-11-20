import type Database from "better-sqlite3";

/**
 * Feishu document assistants (migration 94; `feishu/doc-assistants.ts`): a
 * tenant member's own agent, started from an Octopus control card, running on
 * the card owner's device as the owner's session, reaching the document's
 * project read-only and the document itself through its own via='assistant'
 * share. Also the anchor's project columns the assistants run against.
 */
export type AssistantRights = "read" | "write";

/** The registered workspace a control card's document is linked to. */
export interface DocProject { device: string; workspaceId: string; label: string }

/** What the owner set on one control card: its project, and what assistants may do to the document (null: assistants off). */
export interface DocAssistantSettings { project: DocProject | null; rights: AssistantRights | null }

export interface DocAssistant {
  /** The launch's client_request_id (`op_fda_…`). */
  id: string;
  owner: string;
  anchorId: string;
  shareId: string;
  /** The verified Feishu identity that started it: the one authority over it besides the owner. */
  guestOpenId: string;
  /** Display only. */
  guestName: string;
  title: string;
  device: string;
  workspaceId: string;
  sessionId: string | null;
  createdAt: number;
  pinnedAt: number | null;
  endedAt: number | null;
  /** Why its launch failed, when it did. */
  error: string | null;
  /** Its share's rights on the document, fixed when it started. */
  rights: AssistantRights;
  /** Not ended, and its share still stands: not terminated, its token not revoked. */
  live: boolean;
  /**
   * Live, its share active (not paused), its control card not known gone, and
   * what the card's owner set now still admits it: assistants on, at least
   * its rights, and the project it runs against. It may be used and talked to.
   */
  usable: boolean;
}

/** Rows one list answers at most; newest first. */
const LIST_LIMIT = 200;

interface Row {
  id: string; owner: string; anchor_id: string; share_id: string; guest_open_id: string; guest_name: string; title: string;
  device: string; workspace_id: string; session_id: string | null; created_at: number; pinned_at: number | null;
  ended_at: number | null; error: string | null; rights: AssistantRights; live: number; usable: number;
}
const ROWS = `SELECT a.*, s.rights AS rights,
    (a.ended_at IS NULL AND s.status IN ('active', 'paused') AND t.token_hash IS NOT NULL AND t.revoked_at IS NULL) AS live,
    (a.ended_at IS NULL AND s.status = 'active' AND t.token_hash IS NOT NULL AND t.revoked_at IS NULL AND c.state <> 'missing'
      AND c.assistant_rights IS NOT NULL AND (c.assistant_rights = 'write' OR s.rights = 'read')
      AND c.project_device = a.device AND c.project_workspace = a.workspace_id) AS usable
  FROM feishu_doc_assistants a
  JOIN feishu_doc_shares s ON s.id = a.share_id
  JOIN feishu_doc_share_anchors c ON c.id = a.anchor_id
  LEFT JOIN mcp_tokens t ON t.token_hash = s.mcp_token_hash`;
/** The same liveness, for counting. */
const LIVE = `a.ended_at IS NULL AND EXISTS (SELECT 1 FROM feishu_doc_shares s JOIN mcp_tokens t ON t.token_hash = s.mcp_token_hash
  WHERE s.id = a.share_id AND s.status IN ('active', 'paused') AND t.revoked_at IS NULL)`;

const assistant = (row: Row): DocAssistant => ({
  id: row.id, owner: row.owner, anchorId: row.anchor_id, shareId: row.share_id, guestOpenId: row.guest_open_id, guestName: row.guest_name,
  title: row.title, device: row.device, workspaceId: row.workspace_id, sessionId: row.session_id, createdAt: row.created_at,
  pinnedAt: row.pinned_at, endedAt: row.ended_at, error: row.error, rights: row.rights, live: row.live === 1, usable: row.usable === 1,
});

export class FeishuDocAssistantsRepository {
  constructor(private readonly db: Database.Database) {}

  // ── the control card's settings ──

  settings(anchorId: string): DocAssistantSettings {
    const row = this.db.prepare("SELECT project_device, project_workspace, project_label, assistant_rights FROM feishu_doc_share_anchors WHERE id = ?")
      .get(anchorId) as { project_device: string | null; project_workspace: string | null; project_label: string | null; assistant_rights: AssistantRights | null } | undefined;
    const project = row?.project_device && row.project_workspace
      ? { device: row.project_device, workspaceId: row.project_workspace, label: row.project_label ?? "" } : null;
    return { project, rights: row?.assistant_rights ?? null };
  }

  /** Links the card's document to a project, and sets what assistants may do (null: off; the project stays). */
  configure(anchorId: string, rights: AssistantRights | null, project?: DocProject): void {
    if (project) {
      this.db.prepare("UPDATE feishu_doc_share_anchors SET project_device = ?, project_workspace = ?, project_label = ?, assistant_rights = ? WHERE id = ?")
        .run(project.device, project.workspaceId, project.label, rights, anchorId);
    } else {
      this.db.prepare("UPDATE feishu_doc_share_anchors SET assistant_rights = ? WHERE id = ?").run(rights, anchorId);
    }
  }

  // ── assistants ──

  create(row: Pick<DocAssistant, "id" | "owner" | "anchorId" | "shareId" | "guestOpenId" | "guestName" | "title" | "device" | "workspaceId" | "createdAt">): void {
    this.db.prepare(`INSERT INTO feishu_doc_assistants (id, owner, anchor_id, share_id, guest_open_id, guest_name, title, device, workspace_id,
        session_id, created_at, pinned_at, ended_at, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL)`)
      .run(row.id, row.owner, row.anchorId, row.shareId, row.guestOpenId, row.guestName, row.title, row.device, row.workspaceId, row.createdAt);
  }

  get(id: string): DocAssistant | null {
    const row = this.db.prepare(`${ROWS} WHERE a.id = ?`).get(id) as Row | undefined;
    return row ? assistant(row) : null;
  }

  byShare(shareId: string): DocAssistant | null {
    const row = this.db.prepare(`${ROWS} WHERE a.share_id = ?`).get(shareId) as Row | undefined;
    return row ? assistant(row) : null;
  }

  /** The assistant a provider session is, if any (assistants run as Claude). */
  bySession(owner: string, device: string, sessionId: string): DocAssistant | null {
    const row = this.db.prepare(`${ROWS} WHERE a.owner = ? AND a.device = ? AND a.session_id = ?`).get(owner, device, sessionId) as Row | undefined;
    return row ? assistant(row) : null;
  }

  /** One card's assistants, or one guest's of them; newest first, at most LIST_LIMIT. */
  ofAnchor(anchorId: string, guestOpenId?: string): DocAssistant[] {
    const rows = guestOpenId === undefined
      ? this.db.prepare(`${ROWS} WHERE a.anchor_id = ? ORDER BY a.created_at DESC, a.id DESC LIMIT ?`).all(anchorId, LIST_LIMIT)
      : this.db.prepare(`${ROWS} WHERE a.anchor_id = ? AND a.guest_open_id = ? ORDER BY a.created_at DESC, a.id DESC LIMIT ?`).all(anchorId, guestOpenId, LIST_LIMIT);
    return (rows as Row[]).map(assistant);
  }

  /** Every assistant of one card not yet ended, however many: what the owner's switch must reach. */
  unended(anchorId: string): DocAssistant[] {
    return (this.db.prepare(`${ROWS} WHERE a.anchor_id = ? AND a.ended_at IS NULL`).all(anchorId) as Row[]).map(assistant);
  }

  /** Live assistants on one card; with `guestOpenId`, that guest's only. */
  liveCount(anchorId: string, guestOpenId?: string): number {
    const row = guestOpenId === undefined
      ? this.db.prepare(`SELECT COUNT(*) AS n FROM feishu_doc_assistants a WHERE a.anchor_id = ? AND ${LIVE}`).get(anchorId)
      : this.db.prepare(`SELECT COUNT(*) AS n FROM feishu_doc_assistants a WHERE a.anchor_id = ? AND a.guest_open_id = ? AND ${LIVE}`).get(anchorId, guestOpenId);
    return (row as { n: number }).n;
  }

  /** Assistants one guest started since `since`, on any card, ended or not. */
  startsSince(guestOpenId: string, since: number): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM feishu_doc_assistants WHERE guest_open_id = ? AND created_at > ?").get(guestOpenId, since) as { n: number }).n;
  }

  /** The launch named its provider session; false when the assistant ended or names another one. */
  attach(id: string, owner: string, sessionId: string): boolean {
    return this.db.prepare(`UPDATE feishu_doc_assistants SET session_id = ?
      WHERE id = ? AND owner = ? AND ended_at IS NULL AND (session_id IS NULL OR session_id = ?)`).run(sessionId, id, owner, sessionId).changes > 0;
  }

  /** Why the launch failed, kept for its guest; the assistant ends with its share next. */
  failed(id: string, error: string): void {
    this.db.prepare("UPDATE feishu_doc_assistants SET error = ? WHERE id = ? AND ended_at IS NULL AND error IS NULL").run(error.slice(0, 300), id);
  }

  /** Ended for good (a trigger keeps it so); false when it already was. */
  end(id: string, at: number): boolean {
    return this.db.prepare("UPDATE feishu_doc_assistants SET ended_at = ? WHERE id = ? AND ended_at IS NULL").run(at, id).changes > 0;
  }

  pin(id: string, at: number): void {
    this.db.prepare("UPDATE feishu_doc_assistants SET pinned_at = ? WHERE id = ? AND pinned_at IS NULL").run(at, id);
  }
}
