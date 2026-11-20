import type Database from "better-sqlite3";

/**
 * Read grants on registered Runner workspaces.
 *
 * A grant names one workspace on one of the owner's devices and one grantee
 * account. It confers reading files inside that workspace and nothing else;
 * the Runner keeps every read inside the workspace's real path.
 */
export interface WorkspaceGrant {
  owner: string;
  device: string;
  workspaceId: string;
  grantee: string;
  label: string;
  createdAt: number;
}

interface Row { owner: string; device: string; workspace_id: string; grantee: string; label: string; created_at: number }
const grant = (row: Row): WorkspaceGrant => ({
  owner: row.owner, device: row.device, workspaceId: row.workspace_id, grantee: row.grantee, label: row.label, createdAt: row.created_at,
});

export class WorkspaceGrantsRepository {
  constructor(private readonly db: Database.Database) {}

  has(owner: string, device: string, workspaceId: string, grantee: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM workspace_grants WHERE owner = ? AND device = ? AND workspace_id = ? AND grantee = ?")
      .get(owner, device, workspaceId, grantee));
  }

  /** The grantees of one workspace, oldest first. */
  members(owner: string, device: string, workspaceId: string): WorkspaceGrant[] {
    return (this.db.prepare("SELECT * FROM workspace_grants WHERE owner = ? AND device = ? AND workspace_id = ? ORDER BY created_at, grantee")
      .all(owner, device, workspaceId) as Row[]).map(grant);
  }

  /** Makes `grantees` exactly the workspace's readers; unchanged rows keep their date. Returns the new set. */
  replace(owner: string, device: string, workspaceId: string, label: string, grantees: readonly string[], at: number): WorkspaceGrant[] {
    const wanted = new Set(grantees.filter((name) => name && name !== owner));
    return this.db.transaction(() => {
      const current = this.members(owner, device, workspaceId);
      const drop = this.db.prepare("DELETE FROM workspace_grants WHERE owner = ? AND device = ? AND workspace_id = ? AND grantee = ?");
      for (const row of current) if (!wanted.has(row.grantee)) drop.run(owner, device, workspaceId, row.grantee);
      const add = this.db.prepare("INSERT OR IGNORE INTO workspace_grants (owner, device, workspace_id, grantee, label, created_at) VALUES (?, ?, ?, ?, ?, ?)");
      for (const name of wanted) add.run(owner, device, workspaceId, name, label, at);
      this.db.prepare("UPDATE workspace_grants SET label = ? WHERE owner = ? AND device = ? AND workspace_id = ?").run(label, owner, device, workspaceId);
      return this.members(owner, device, workspaceId);
    })();
  }

  /** An account that ended keeps nothing it was granted. */
  dropGrantee(grantee: string): number {
    return this.db.prepare("DELETE FROM workspace_grants WHERE grantee = ?").run(grantee).changes;
  }
}
