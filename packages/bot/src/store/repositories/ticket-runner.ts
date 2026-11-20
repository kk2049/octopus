import type Database from "better-sqlite3";
import type { SessionInputReceipt, SessionOperationReceipt } from "@claude-bot/runner/gateway-protocol";
import type { RetrievalTraceId } from "../../knowledge/retrieval-trace.js";

export interface TicketRunnerBinding {
  owner: string;
  /** Real ticket author for an explicitly delegated provider; absent on legacy own-device tickets. */
  requester?: string;
  parentWorkspaceId?: string;
  device: string;
  workspaceId: string;
  executionDevice?: string;
  codexAccount?: string;
  source: "claude" | "codex" | "omp";
}
export interface TicketRunnerTurn {
  id: string;
  ticketId: number;
  turn: number;
  method: "start_session" | "append_session";
  args: Record<string, unknown>;
  state: "prepared" | "dispatched" | "finished";
  messageIds?: number[];
  /** Bound to the persisted first prompt; recovery observes, never regenerates it. */
  startupTraceId?: RetrievalTraceId;
  /** Persist intent against this operation, never whichever turn runs next. */
  stopRequestedBy?: string;
  /** Definite completion survives Runner receipt eviction; unknown remains query-only. */
  receipt?: Pick<SessionOperationReceipt, "protocol" | "operation_id" | "state" | "session_id" | "input" | "result">;
}

export interface TicketRunnerInput {
  id: string;
  ticketId: number;
  turnId: string;
  turn: number;
  messageIds: number[];
  args: Record<string, unknown>;
  attachmentBodies?: string[];
  state: "prepared" | "dispatched" | "accepted" | "failed" | "unknown" | "queued";
}

/** Durable pipeline custody; the device remains the execution authority. */
export class TicketRunnerRepository {
  constructor(private readonly db: Database.Database) {}
  messageDelivery(ids: readonly number[], state: "sending" | "delivered" | "failed" | "unknown", error?: string, input?: SessionInputReceipt): void {
    const update = this.db.prepare(`UPDATE ticket_messages SET delivery_state=?, delivery_error=?,delivery_input=COALESCE(?,delivery_input)
      WHERE id=? AND (delivery_state IS NULL OR delivery_state <> 'delivered' OR ?='delivered')`);
    this.db.transaction(() => { for (const id of ids) update.run(state, error?.slice(0, 600) ?? null, input ? JSON.stringify(input) : null, id, state); })();
  }
  inputs(turnId: string): TicketRunnerInput[] {
    return (this.db.prepare("SELECT record FROM dev_runner_inputs WHERE turn_id=? AND state IN ('prepared','dispatched') ORDER BY rowid")
      .all(turnId) as Array<{ record: string }>).map((row) => JSON.parse(row.record) as TicketRunnerInput);
  }
  inputChannelClosed(turnId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM dev_runner_inputs WHERE turn_id=? AND state='queued' LIMIT 1").get(turnId));
  }
  input(id: string): TicketRunnerInput | null {
    const row = this.db.prepare("SELECT record FROM dev_runner_inputs WHERE id=?").get(id) as { record: string } | undefined;
    return row ? JSON.parse(row.record) as TicketRunnerInput : null;
  }
  saveInput(input: TicketRunnerInput): void {
    this.db.prepare(`INSERT INTO dev_runner_inputs(id,ticket_id,turn_id,state,record) VALUES (?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET state=excluded.state,record=excluded.record`)
      .run(input.id, input.ticketId, input.turnId, input.state, JSON.stringify(input));
  }
  /** Claim exactly these still-unread rows and their stable operation atomically. */
  claimInput(input: TicketRunnerInput): boolean {
    return this.db.transaction(() => {
      const ticket = this.db.prepare("SELECT chat_paused FROM dev_tickets WHERE id=?").get(input.ticketId) as { chat_paused: number };
      if (ticket.chat_paused || this.active(input.ticketId)?.id !== input.turnId) return false;
      const claim = this.db.prepare(`UPDATE ticket_messages SET delivered_turn=?, delivery_state='sending'
        WHERE id=? AND ticket_id=? AND delivered_turn IS NULL`);
      for (const id of input.messageIds) {
        if (claim.run(input.turn, id, input.ticketId).changes !== 1) throw new Error("工单消息认领已变化");
      }
      this.saveInput(input);
      return true;
    })();
  }
  settleInput(input: TicketRunnerInput, state: "accepted" | "failed" | "unknown" | "queued", error?: string, receipt?: SessionInputReceipt): void {
    this.db.transaction(() => {
      if (state === "queued") {
        const reset = this.db.prepare("UPDATE ticket_messages SET delivered_turn=NULL,delivery_state=NULL,delivery_error=NULL,delivery_input=NULL WHERE id=?");
        for (const id of input.messageIds) reset.run(id);
      } else this.messageDelivery(input.messageIds, state === "accepted" ? "delivered" : state, error, receipt);
      this.saveInput({ ...input, state });
    })();
  }
  binding(ticketId: number): TicketRunnerBinding | null {
    const row = this.db.prepare("SELECT binding FROM dev_runner_bindings WHERE ticket_id = ?").get(ticketId) as { binding: string } | undefined;
    return row ? JSON.parse(row.binding) as TicketRunnerBinding : null;
  }
  bind(ticketId: number, binding: TicketRunnerBinding): void {
    const previous = this.binding(ticketId);
    if (previous && JSON.stringify(previous) !== JSON.stringify(binding)) throw new Error("工单 Runner 绑定不可隐式更换");
    this.db.prepare("INSERT OR IGNORE INTO dev_runner_bindings(ticket_id, binding) VALUES (?, ?)").run(ticketId, JSON.stringify(binding));
  }
  /** One explicit pre-launch parent→managed-child transition; never migrates a live session. */
  bindDevelopmentWorkspace(ticketId: number, childWorkspaceId: string): TicketRunnerBinding {
    return this.db.transaction(() => {
      const previous = this.binding(ticketId);
      const ticket = this.db.prepare("SELECT session_id FROM dev_tickets WHERE id=?").get(ticketId) as { session_id: string | null } | undefined;
      const development = this.db.prepare("SELECT record FROM dev_development_bindings WHERE ticket_id=?").get(ticketId) as { record: string } | undefined;
      const bound = development ? JSON.parse(development.record) as import("./ticket-development.js").TicketDevelopmentBinding : null;
      if (!previous || !ticket || ticket.session_id || this.latest(ticketId) || !bound || bound.owner !== previous.owner
        || bound.requester !== previous.requester || bound.device !== (previous.executionDevice || previous.device) || bound.parentWorkspaceId !== previous.workspaceId
        || bound.worktreeWorkspaceId !== childWorkspaceId) throw new Error("development workspace may only bind an unstarted ticket to its verified child");
      const next = { ...previous, workspaceId: childWorkspaceId };
      this.db.prepare("UPDATE dev_runner_bindings SET binding=? WHERE ticket_id=?").run(JSON.stringify(next), ticketId);
      return next;
    })();
  }
  get(id: string): TicketRunnerTurn | null {
    const row = this.db.prepare("SELECT record FROM dev_runner_turns WHERE id = ?").get(id) as { record: string } | undefined;
    return row ? JSON.parse(row.record) as TicketRunnerTurn : null;
  }
  // Operations are inserted once, then updated in place by save(). The turn
  // counter belongs to a Bot process and may restart at 1; it is not chronology.
  latestStart(ticketId: number): TicketRunnerTurn | null {
    const row = this.db.prepare("SELECT record FROM dev_runner_turns WHERE ticket_id = ? AND json_extract(record, '$.method') = 'start_session' ORDER BY rowid DESC LIMIT 1")
      .get(ticketId) as { record: string } | undefined;
    return row ? JSON.parse(row.record) as TicketRunnerTurn : null;
  }
  active(ticketId: number): TicketRunnerTurn | null {
    const row = this.db.prepare("SELECT record FROM dev_runner_turns WHERE ticket_id = ? AND state <> 'finished'").get(ticketId) as { record: string } | undefined;
    return row ? JSON.parse(row.record) as TicketRunnerTurn : null;
  }
  /** Most recently inserted operation, including after its completion. */
  latest(ticketId: number): TicketRunnerTurn | null {
    const row = this.db.prepare("SELECT record FROM dev_runner_turns WHERE ticket_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(ticketId) as { record: string } | undefined;
    return row ? JSON.parse(row.record) as TicketRunnerTurn : null;
  }
  activeTicketIds(): number[] {
    return (this.db.prepare("SELECT ticket_id FROM dev_runner_turns WHERE state <> 'finished' ORDER BY ticket_id").all() as Array<{ ticket_id: number }>).map((row) => row.ticket_id);
  }
  save(turn: TicketRunnerTurn): void {
    const stopRequestedBy = this.get(turn.id)?.stopRequestedBy ?? turn.stopRequestedBy;
    const record = stopRequestedBy ? { ...turn, stopRequestedBy } : turn;
    this.db.prepare(`INSERT INTO dev_runner_turns(id, ticket_id, state, record) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET state = excluded.state, record = excluded.record`)
      .run(turn.id, turn.ticketId, turn.state, JSON.stringify(record));
  }
  /** A paused pre-dispatch turn has provably sent nothing; retain its inbox. */
  releasePrepared(turn: TicketRunnerTurn): void {
    this.db.transaction(() => {
      const current = this.active(turn.ticketId);
      if (current?.id !== turn.id || current.state !== "prepared") return;
      const reset = this.db.prepare(`UPDATE ticket_messages SET delivered_turn=NULL,
        delivery_state=NULL,delivery_error=NULL,delivery_input=NULL WHERE id=? AND delivery_state='sending'`);
      for (const id of current.messageIds ?? []) reset.run(id);
      this.finish(current, {});
    })();
  }

  /** Completion + agent reply + marker clear must survive a crash as one fact. */
  finish(turn: TicketRunnerTurn, result: { text?: string; error?: string; sessionId?: string }, onFinish?: () => void): boolean {
    return this.db.transaction(() => {
      const active = this.active(turn.ticketId);
      if (active?.id !== turn.id) return false;
      const now = new Date().toISOString();
      if (result.text) this.db.prepare(`INSERT INTO ticket_messages(ticket_id,author,via,body,delivered_turn,actor_kind,created_at)
        VALUES (?, 'agent', 'agent', ?, ?, 'system', ?)`).run(turn.ticketId, result.text, turn.turn, now);
      this.db.prepare(`UPDATE dev_tickets SET turn_started_at = NULL, error = ?,
        session_id = COALESCE(?, session_id), updated_at = ? WHERE id = ?`)
        .run(result.error ?? null, result.sessionId ?? null, now, turn.ticketId);
      onFinish?.();
      this.save({ ...turn, state: "finished" });
      return true;
    })();
  }
}
