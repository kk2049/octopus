import type Database from "better-sqlite3";
import type { WorkspaceDevelopmentCandidate, WorkspaceDevelopmentStatus } from "@claude-bot/runner/workspace-development-protocol";

/** Placement is not authority: every RPC reopens the bound provider capability. */
export interface TicketDevelopmentBinding {
  ticketId: number; owner: string; requester?: string; device: string; parentWorkspaceId: string;
  repositoryId: string; developmentId: string; baseSha: string;
  worktreeWorkspaceId?: string;
}
export interface TicketDevelopmentOperation {
  id: string; ticketId: number; key: string; action: "prepare" | "sync" | "export";
  args: Record<string, unknown>; state: "prepared" | "dispatched" | "finished";
  receipt?: WorkspaceDevelopmentStatus;
}
export interface TicketDevelopmentCandidate {
  ticketId: number; candidate: WorkspaceDevelopmentCandidate; imported: boolean;
}
export class TicketDevelopmentRepository {
  constructor(private readonly db: Database.Database) {}
  binding(ticketId: number): TicketDevelopmentBinding | null {
    const row = this.db.prepare("SELECT record FROM dev_development_bindings WHERE ticket_id = ?").get(ticketId) as { record: string } | undefined;
    return row ? JSON.parse(row.record) as TicketDevelopmentBinding : null;
  }
  /** Recovery must not downgrade a durable development session before its live turn reattaches. */
  sessionRequired(owner: string, runtimeDevice: string, source: string, sessionId: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM dev_development_bindings d
      JOIN dev_tickets t ON t.id=d.ticket_id JOIN dev_runner_bindings r ON r.ticket_id=t.id
      WHERE t.requester=COALESCE(json_extract(r.binding,'$.requester'), json_extract(r.binding,'$.owner'))
        AND t.requester=COALESCE(json_extract(d.record,'$.requester'), json_extract(d.record,'$.owner'))
        AND t.session_id=? AND json_extract(d.record,'$.owner')=?
        AND json_extract(r.binding,'$.owner')=? AND json_extract(r.binding,'$.device')=?
        AND json_extract(r.binding,'$.source')=? LIMIT 1`).get(sessionId, owner, owner, runtimeDevice, source));
  }
  bind(binding: TicketDevelopmentBinding): void {
    const prior = this.binding(binding.ticketId);
    if (prior) {
      const { worktreeWorkspaceId: oldChild, ...oldIdentity } = prior;
      const { worktreeWorkspaceId: nextChild, ...nextIdentity } = binding;
      if (JSON.stringify(oldIdentity) !== JSON.stringify(nextIdentity) || (oldChild && oldChild !== nextChild)) throw new Error("development placement cannot change implicitly");
    }
    this.db.prepare("INSERT INTO dev_development_bindings(ticket_id,record) VALUES(?,?) ON CONFLICT(ticket_id) DO UPDATE SET record=excluded.record")
      .run(binding.ticketId, JSON.stringify(binding));
  }
  operation(ticketId: number, key: string): TicketDevelopmentOperation | null {
    const row = this.db.prepare("SELECT record FROM dev_development_operations WHERE ticket_id = ? AND operation_key = ? ORDER BY attempt DESC LIMIT 1")
      .get(ticketId, key) as { record: string } | undefined;
    return row ? JSON.parse(row.record) as TicketDevelopmentOperation : null;
  }
  save(operation: TicketDevelopmentOperation): void {
    this.db.prepare("INSERT INTO dev_development_operations(id,ticket_id,operation_key,attempt,record) VALUES(?,?,?,COALESCE((SELECT MAX(attempt)+1 FROM dev_development_operations WHERE ticket_id=? AND operation_key=?),1),?) ON CONFLICT(id) DO UPDATE SET record=excluded.record")
      .run(operation.id, operation.ticketId, operation.key, operation.ticketId, operation.key, JSON.stringify(operation));
  }
  candidate(ticketId: number): TicketDevelopmentCandidate | null {
    const row = this.db.prepare("SELECT candidate FROM dev_development_bindings WHERE ticket_id = ?").get(ticketId) as { candidate: string | null } | undefined;
    return row?.candidate ? JSON.parse(row.candidate) as TicketDevelopmentCandidate : null;
  }
  saveCandidate(record: TicketDevelopmentCandidate): void {
    this.db.prepare("UPDATE dev_development_bindings SET candidate=? WHERE ticket_id=?").run(JSON.stringify(record), record.ticketId);
  }
}
