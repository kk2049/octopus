/**
 * SessionOperationCoordinator — one chat submission, as a thing with a life.
 *
 * ── The failure this exists to prevent ─────────────────────────────────────
 *
 * A submission used to BE an HTTP request. The page pressed send, the server
 * held the socket open for as long as the CLI ran, and everything a person
 * needs to know — is a human still deciding this? is it running on my laptop?
 * did it finish? — lived in that socket. So:
 *
 *  · a 202 "queued for approval" was the last thing the chat ever heard: the
 *    approval's result went back to whoever pressed the button on /pending,
 *    not to the conversation that asked for it;
 *  · reloading the page lost the state, because it was never written down;
 *  · an auto-allowed submission held one HTTP request open for minutes, and so
 *    did the approval endpoint — the network connection was carrying a
 *    lifecycle it has no way to represent.
 *
 * The fix is not a nicer spinner. It is that a submission is a durable record
 * with an id, and every entry point — the composer, the approval drawer, a
 * reload, a restarted process — reports the SAME record.
 *
 * ── Three rules that are not negotiable ────────────────────────────────────
 *
 * 1. **Nothing here ever replays a call.** A `running` row at boot becomes
 *    `unknown`, not "retry": the frame left the process, and `append_session`
 *    is not idempotent — a second turn is a second turn. `unknown` is an
 *    answer; the transcript is where the user finds out what actually landed.
 * 2. **The browser never names what runs.** A submission carries an operation
 *    id and nothing else; the device, session, prompt and operation were frozen
 *    when the capability PendingCall was created, and approval re-runs exactly
 *    that.
 * 3. **A refusal is not a lifecycle.** `prepareAppend` refuses before any row
 *    exists, so "you were told no" never leaves an operation record behind.
 */

import { createHash, randomUUID } from "node:crypto";
import { sessionOperationReceiptFromWire, type SessionOperationReceipt } from "@claude-bot/runner/gateway-protocol";
import type { SessionInputReceipt } from "@claude-bot/agent-sessions-contract";
import { inputForView, storedInputOf, type SessionReceiptTarget } from "./operation-receipts.js";
import { recordConvergenceUsage, type ConvergenceOutcome } from "@claude-bot/convergence-gates";
import { SessionReceiptQueryError, type RunnerCapabilities } from "../runner/capability.js";
import { ManagedExecutionSupervisor, type ExecutionStep } from "../managed-execution/supervisor.js";
import { ResourceRecoveryService, runnerResource } from "../resources/recovery.js";
import type { ManagedExecutionRow } from "../store/repositories/managed-executions.js";
import { receiptTargetOf } from "./operation-receipts.js";
import type { SessionOperationRow, Store } from "../store/store.js";
import type { HubPrincipal } from "./service.js";
import { createLogger } from "../logger.js";

const log = createLogger("session-operations");

export type OperationSurface = "hub" | "mcp:sessions" | "app:session-plus" | "app:research-program" | "app:research-v2";

/** Stable identity of one intent, computed without taking authority. */
export interface OperationIntent {
  runnerOperationId?: string;
  owner: string;
  resourceId: string;
  device: string;
  cliKind: string;
  sessionId: string;
  operation: string;
  fingerprint: string;
}

/** A prepared call owns whatever grant/lease its executor needs. */
export interface OperationTicket extends OperationIntent {
  receiptTarget?: SessionReceiptTarget;
  contextId: string;
}

export interface OperationHooks {
  onDispatched?(contextId: string): void;
  onPending?(pendingCallId: string, contextId: string): void;
}

export type OperationOutcome =
  | {
      ok: true;
      result: unknown;
      receipt?: SessionOperationReceipt;
      sessionId?: string;
      newSessionId?: string;
      durationMs?: number;
    }
  | {
      ok: false;
      status: number;
      error: string;
      pendingCallId?: string;
      approvalRequired?: boolean;
      indeterminate?: boolean;
    };

export type OperationRefusal = { ok: false; status: number; error: string; pendingCallId?: string };

/**
 * The single lifecycle state machine has exactly two resource adapters. An
 * executor owns resource-specific preparation and result interpretation; it
 * cannot write operation rows or choose another surface.
 */
export interface OperationExecutor<Input = unknown, Ticket extends OperationTicket = OperationTicket> {
  describe(principal: HubPrincipal, input: Input): { ok: true; intent: OperationIntent } | OperationRefusal;
  prepare(
    principal: HubPrincipal,
    input: Input,
    operationId: string,
  ): { ok: true; ticket: Ticket } | OperationRefusal;
  run(ticket: Ticket, hooks?: OperationHooks): Promise<OperationOutcome>;
  interpret(result: unknown, intent: OperationIntent): OperationOutcome;
  discard(ticket: Ticket): void;
  releasePending(pendingCallId: string): void;
}

export const SESSION_OPERATION_STATUSES = [
  "submitted",
  "waiting_approval",
  "running",
  "succeeded",
  "failed",
  "rejected",
  "unknown",
] as const;
export type SessionOperationStatus = (typeof SESSION_OPERATION_STATUSES)[number];

const LIVE: ReadonlySet<string> = new Set(["submitted", "waiting_approval", "running"]);

/**
 * How long an `unknown` receipt is still worth querying. The Runner can learn
 * late evidence only while it observes the original request (detached launches
 * and capacity continuations both settle within 30 minutes); after that the
 * transcript is the answer and the record stops polling.
 */
export const UNKNOWN_RECEIPT_OBSERVATION_MS = 30 * 60_000;

/** What the browser is told about one submission. Server-authored, wholesale. */
export interface SessionOperationView {
  input?: SessionInputReceipt;
  recovery?: { state: "reconnecting" | "waiting_resource"; since: string; resource: string; retry_at: string | null };
  id: string;
  owner: string;
  surface: OperationSurface;
  resourceId: string;
  device: string;
  cliKind: string;
  sessionId: string;
  operation: string;
  status: SessionOperationStatus;
  /** Present once a human has to decide; the id is opaque and owner-scoped. */
  pendingCallId?: string;
  /** Short summary — never the transcript, never the prompt. */
  detail?: string;
  newSessionId?: string;
  submittedAt: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
  /** Can this record still change? The page must not derive this itself. */
  live: boolean;
  /** The sentence the chip renders. Written here so one wording exists. */
  message: string;
}

export interface SubmitRefusal {
  ok: false;
  status: number;
  error: string;
  pendingCallId?: string;
}

export interface SubmitAccepted {
  ok: true;
  operation: SessionOperationView;
  /**
   * The first state this submission can report — it resolves as soon as the
   * record leaves `submitted`, i.e. when the call is at the device, waiting for
   * a human, or already over.
   *
   * The unified transport ignores it (the record and its stream are the
   * answer). The legacy transport awaits it, which is exactly the old
   * behaviour: one request, one outcome.
   */
  settled: Promise<{ view: SessionOperationView; outcome?: OperationOutcome }>;
}

export interface CoordinatorOptions {
  store: Store;
  executors: Readonly<Partial<Record<OperationSurface, OperationExecutor<any, any>>>>;
  /** Absent = no laptop devices, so nothing can be approved or executed. */
  caps?: RunnerCapabilities;
  now?: () => number;
  /** Test seam. */
  newId?: () => string;
  supervisor?: ManagedExecutionSupervisor;
}

type Listener = (view: SessionOperationView) => void;

export class SessionOperationCoordinator {
  private listeners = new Map<string, Set<Listener>>();
  private readonly supervisor: ManagedExecutionSupervisor;
  private readonly detachSupervisors: Array<() => void> = [];
  private closed = false;
  private nowMs: () => number;
  private newId: () => string;
  /** Raw results for submissions still being awaited by their own request. */
  private inflight = new Map<string, (r: { view: SessionOperationView; outcome?: OperationOutcome }) => void>();
  private receiptWaits = new Set<string>();

  constructor(private opts: CoordinatorOptions) {
    this.nowMs = opts.now ?? Date.now;
    this.newId = opts.newId ?? (() => `op_${randomUUID().replace(/-/g, "").slice(0, 20)}`);
    this.supervisor = opts.supervisor ?? new ManagedExecutionSupervisor(opts.store.managedExecutions,
      new ResourceRecoveryService(opts.store.resourceWaiters), this.nowMs);
    for (const source of ["session", "research", "mcp-session"] as const) {
      this.detachSupervisors.push(this.supervisor.register(source, {
        authorized: job => Boolean(this.row(job.reference, job.owner) && this.opts.caps),
        reconcile: async (lease) => {
          const job = lease.row;
          const row = this.row(job.reference, job.owner);
          if (!row || !["running", "unknown"].includes(row.status)) return { kind: "completed" };
          try {
            const value = await this.opts.caps!.querySessionOperation(row.owner, row.id);
            lease.assertCurrent();
            const receipt = sessionOperationReceiptFromWire(value, row.runner_operation_id!);
            if (receipt) {
              const view = this.applyReceipt(row, receipt);
              if (!["running", "unknown"].includes(view.status)) return { kind: "completed" };
              // Unknown is observation of the original send, never another send.
              if (view.status === "unknown") return this.unknownReceiptStep(this.row(row.id, row.owner) ?? row);
            }
            return { kind: "observe", delayMs: 250 };
          } catch (error) {
            if (error instanceof SessionReceiptQueryError && error.failure === "authorization_revoked") {
              return { kind: "unknown", detail: error.message };
            }
            const settled = row.status === "unknown" ? this.unknownReceiptStep(row) : undefined;
            if (settled?.kind === "unknown") return settled;
            if (error instanceof SessionReceiptQueryError && error.failure === "transport_unavailable") {
              return { kind: "wait", dependency: runnerResource(receiptTargetOf(row)?.owner ?? row.owner, row.device),
                detail: "设备连接暂不可用；恢复后继续查询原输入回执" };
            }
            return settled ?? { kind: "observe", delayMs: 5000 };
          }
        },
        changed: job => this.receiptRecoveryChanged(job),
      }));
    }
  }

  /**
   * Keep an unknown receipt observable while late evidence can still arrive,
   * backing off from 5 s to a minute, then end the observation. The record
   * keeps its reason and says that querying stopped; nothing is ever resent.
   */
  private unknownReceiptStep(row: SessionOperationRow): ExecutionStep {
    const since = Date.parse(row.finished_at ?? row.updated_at);
    const elapsed = Number.isFinite(since) ? Math.max(0, this.nowMs() - since) : 0;
    if (elapsed < UNKNOWN_RECEIPT_OBSERVATION_MS) {
      return { kind: "observe", delayMs: Math.min(60_000, Math.max(5_000, Math.round(elapsed / 10))) };
    }
    const reason = row.detail?.trim().replace(/[。；;]+$/u, "");
    return { kind: "unknown", detail: `${reason ? `${reason}；` : ""}30 分钟内没有新的输入证据，已停止查询原回执，不会自动重发`.slice(0, 600) };
  }

  // ── boot ──

  /**
   * Reconcile what the last process left behind. Called once at startup.
   *
   * `submitted` and `running` both become `unknown`: in either state a frame may
   * already have reached the device, and there is no evidence in this process to
   * say whether it did. Guessing in the optimistic direction would report a turn
   * that never ran; guessing in the pessimistic direction invites a retry, and a
   * retried `append_session` is a second turn on someone's machine.
   *
   * `waiting_approval` rows are NOT swept: the capability kernel's PendingCall
   * is durable, so the card really is still there. They are reconciled against
   * the kernel instead — which is also where an approval decided while this
   * process was down gets picked up.
   */
  recover(): { unknown: number; reconciled: number } {
    let unknown = 0;
    let reconciled = 0;
    for (const row of this.opts.store.listLiveSessionOperations()) {
      if (row.status === "waiting_approval") {
        if (this.reconcile(row) !== row.status) reconciled++;
        continue;
      }
      this.write(row, {
        status: "unknown",
        detail:
          "进程在这一轮执行期间重启 — 无法证明它是否已经在设备上跑过,所以不会自动重发。"
          + "请查看会话正文确认实际写入了什么。",
        finished_at: this.iso(),
      });
      unknown++;
    }
    // Every observable receipt, one bounded window at a time: memory holds one
    // window, and none is left unobserved however many a restart finds.
    for (let before: number | undefined; ;) {
      const page = this.opts.store.listRecoverableSessionOperations({ beforeSequence: before });
      for (const row of page.rows) this.observeReceipt(row);
      if (page.next === null) break;
      before = page.next;
    }
    if (unknown || reconciled) log.info({ unknown, reconciled }, "session operations recovered");
    return { unknown, reconciled };
  }

  // ── submit ──

  /**
   * Accept one chat submission.
   *
   * Returns a REFUSAL (no record) or an accepted record. A duplicate — same
   * owner, same session, same operation, same prompt — joins the record that
   * already exists rather than starting a second turn: a double-clicked button
   * is one intent, and the single-writer lease and the kernel's approval dedupe
   * both agree with that at their own layers.
   */
  async submit<Input>(
    surface: OperationSurface,
    principal: HubPrincipal,
    input: Input,
    options?: { requestId: string },
  ): Promise<SubmitRefusal | SubmitAccepted> {
    const executor = this.opts.executors[surface] as OperationExecutor<Input> | undefined;
    if (!executor) return { ok: false, status: 404, error: `未知 operation surface: ${surface}` };
    const described = executor.describe(principal, input);
    if (!described.ok) return described;
    const intent = described.intent;
    // Durable callers can reconnect the same intent after a lost response. This
    // key names a receipt, including terminal/unknown receipts; it never replays.
    const requestedId = options ? `op_${createHash('sha256').update(JSON.stringify([intent.owner, surface, options.requestId])).digest('hex')}` : undefined;
    if (requestedId) {
      const prior = this.opts.store.getSessionOperation(requestedId, intent.owner);
      if (prior) {
        if (prior.surface !== surface || prior.resource_id !== intent.resourceId || prior.args_hash !== intent.fingerprint) return {ok: false, status: 409, error: '请求 ID 已用于不同的会话操作'};
        const view = this.viewOf(this.reconcileRow(prior));
        return {ok: true, operation: view, settled: Promise.resolve({view})};
      }
    }

    // Owner is the authenticated principal's, checked again inside each
    // executor. This lookup is scoped before it runs rather than filtered after.
    if (!requestedId && principal.username === intent.owner) {
      const existing = this.opts.store.findLiveSessionOperation(
        intent.owner,
        surface,
        intent.resourceId,
        intent.fingerprint,
      );
      // Reconcile BEFORE treating it as a duplicate. A row can say
      // `waiting_approval` about a card that was rejected, expired, or decided
      // through a route this coordinator never saw — joining that would answer
      // "already queued" for something that is over, and the user's new
      // instruction would never run.
      const fresh = existing ? this.reconcileRow(existing) : null;
      if (fresh && LIVE.has(fresh.status)) {
        const view = this.viewOf(fresh);
        return { ok: true, operation: view, settled: Promise.resolve({ view }) };
      }
    }

    // The row id is also the device-side client_request_id for start_session.
    // It is minted here, by the trusted coordinator, before the executor asks
    // the Gate to freeze any arguments.
    const operationId = requestedId ?? this.newId();
    const prepared = executor.prepare(principal, input, operationId);
    if (!prepared.ok) return prepared;
    const ticket = prepared.ticket;
    if (!sameIntent(intent, ticket)) {
      executor.discard(ticket);
      log.error({ surface, owner: intent.owner }, "operation executor changed its intent during prepare");
      return { ok: false, status: 500, error: "操作准备结果与已描述意图不一致" };
    }

    const at = this.iso();
    const binding = ticket.sessionId ? (this.opts.store.getSessionPlusSplitSession(ticket.owner, ticket.device, ticket.cliKind, ticket.sessionId)
      ?? this.opts.store.getSessionExecutionBinding(ticket.owner, ticket.device, ticket.cliKind, ticket.sessionId, "0000-01-01T00:00:00.000Z")) : undefined;
    const receiptTarget = ticket.receiptTarget ?? (binding
      ? { owner: binding.runtime_owner, ...(binding.runtime_resource_id ? { resourceId: binding.runtime_resource_id } : {}) }
      : { owner: ticket.owner });
    const row: SessionOperationRow = {
      id: operationId,
      owner: ticket.owner,
      surface,
      credential: principal.credential,
      resource_id: ticket.resourceId,
      device: ticket.device,
      cli_kind: ticket.cliKind,
      session_id: ticket.sessionId,
      operation: ticket.operation,
      args_hash: ticket.fingerprint,
      runner_operation_id: ticket.runnerOperationId ?? null,
      runner_receipt_target: ticket.runnerOperationId ? JSON.stringify(receiptTarget) : null,
      pending_call_id: null,
      context_id: ticket.contextId,
      status: "submitted",
      detail: null,
      new_session_id: null,
      submitted_at: at,
      started_at: null,
      finished_at: null,
      updated_at: at,
    };
    try {
      this.opts.store.createSessionOperation(row);
    } catch (err) {
      // No record means no lifecycle, so give the authority straight back
      // rather than leaving a session wedged behind a lease nobody owns.
      executor.discard(ticket);
      log.error({ err, owner: ticket.owner }, "could not record a session operation");
      return { ok: false, status: 500, error: "无法记录这次提交,请重试" };
    }
    try {
      // Keep the control plane bounded without ever pruning evidence that still
      // claims work is in flight. A pruning failure is housekeeping failure,
      // not grounds to discard a submission that was already durably recorded.
      this.opts.store.pruneSessionOperations(ticket.owner);
    } catch (err) {
      log.warn({ err, owner: ticket.owner }, "could not prune old session operations");
    }

    const settled = new Promise<{ view: SessionOperationView; outcome?: OperationOutcome }>((resolve) => {
      this.inflight.set(row.id, resolve);
    });
    // Background by design, so it needs its own last-resort handler: an
    // unhandled rejection here would take the process down over one submission.
    void this.execute(row.id, surface, executor, ticket).catch((err: unknown) =>
      log.error({ err, id: row.id }, "session operation bookkeeping failed"),
    );
    return { ok: true, operation: this.viewOf(row), settled };
  }

  /**
   * Run a prepared submission and record every transition it makes.
   *
   * Deliberately not awaited by `submit`: an auto-allowed turn takes minutes,
   * and the whole point of the record is that nothing has to hold a socket open
   * for it.
   */
  private async execute(
    id: string,
    surface: OperationSurface,
    executor: OperationExecutor<any>,
    ticket: OperationTicket,
  ): Promise<void> {
    try {
      await this.runAndRecord(id, executor, ticket);
    } catch (err) {
      // Nothing above may leave a waiter hanging: in the legacy transport an
      // unresolved `settled` is an HTTP request that never answers. Recording
      // the failure and releasing is strictly better than a wedged socket.
      log.error({ err, id }, "session operation execution threw");
      this.finish(id, ticket.owner, {
        ok: false,
        status: 500,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      const waiter = this.inflight.get(id);
      if (waiter) {
        this.inflight.delete(id);
        let view: SessionOperationView;
        try {
          view = this.get(ticket.owner, id) ?? this.viewOf(this.stub(id, surface, ticket));
        } catch {
          view = this.viewOf(this.stub(id, surface, ticket));
        }
        waiter({ view });
      }
    }
  }

  private async runAndRecord(
    id: string,
    executor: OperationExecutor<any>,
    ticket: OperationTicket,
  ): Promise<void> {
    const outcome = await executor.run(ticket, {
      onDispatched: () => {
        // Only from `submitted`: a record that has already moved on (a card was
        // created, or it finished) must not be dragged back to "running" by a
        // signal whose whole job is to make a chip say the right thing.
        const row = this.row(id, ticket.owner);
        if (row?.status === "submitted") {
          this.write(row, { status: "running", started_at: this.iso() });
        }
      },
      onPending: (pendingCallId) => {
        const row = this.row(id, ticket.owner);
        if (row && LIVE.has(row.status)) {
          this.write(row, { status: "waiting_approval", pending_call_id: pendingCallId });
        }
      },
    });
    this.finish(id, ticket.owner, outcome);
  }

  /**
   * The last thing this coordinator can say about a record whose row has gone —
   * enough to answer a caller that is still waiting, and nothing more.
   */
  private stub(id: string, surface: OperationSurface, ticket: OperationTicket): SessionOperationRow {
    const at = this.iso();
    return {
      id,
      owner: ticket.owner,
      surface,
      credential: "",
      resource_id: "",
      device: ticket.device,
      cli_kind: ticket.cliKind,
      session_id: ticket.sessionId,
      operation: ticket.operation,
      args_hash: ticket.fingerprint,
      pending_call_id: null,
      context_id: ticket.contextId,
      status: "unknown",
      detail: "这次提交的记录已经不在了 — 无法证明它是否执行过。",
      new_session_id: null,
      submitted_at: at,
      started_at: null,
      finished_at: at,
      updated_at: at,
    };
  }

  /** Apply a terminal (or waiting) outcome and release anyone awaiting it. */
  private finish(id: string, owner: string, outcome: OperationOutcome): void {
    const row = this.row(id, owner);
    if (!row) return;
    let view: SessionOperationView;
    if (outcome.ok && outcome.receipt) {
      view = this.applyReceipt(row, outcome.receipt);
    } else if (outcome.ok) {
      const result = (outcome.result ?? {}) as Record<string, unknown>;
      view = this.write(row, {
        status: "succeeded",
        detail: summarise(result),
        ...(outcome.sessionId ? { session_id: outcome.sessionId } : {}),
        new_session_id: outcome.newSessionId ?? null,
        finished_at: this.iso(),
      });
    } else if (outcome.approvalRequired) {
      // `runAppend` already reported this through `onPending`; re-reading keeps
      // the awaited view in step with the row rather than with the callback.
      view = this.viewOf(this.row(id, owner) ?? row);
    } else {
      view = this.write(row, {
        status: outcome.indeterminate ? "unknown" : "failed",
        detail: outcome.error.slice(0, 600),
        finished_at: this.iso(),
      });
    }
    if (row.runner_operation_id && (view.status === "running" || view.status === "unknown")) {
      this.observeReceipt(this.row(id, owner) ?? row);
    }
    const waiter = this.inflight.get(id);
    if (waiter) {
      this.inflight.delete(id);
      waiter({ view, outcome });
    }
  }

  /** One row owns both the input evidence and its UI action outcome. */
  private applyReceipt(row: SessionOperationRow, receipt: SessionOperationReceipt): SessionOperationView {
    const fresh = this.row(row.id, row.owner) ?? row;
    if (fresh.status === "succeeded" || fresh.status === "failed" || fresh.status === "rejected") return this.viewOf(fresh);
    if (receipt.operation_id !== fresh.runner_operation_id) return this.viewOf(fresh);
    const stored = storedInputOf(fresh);
    const ranks = { dispatched: 0, local_queued: 1, provider_accepted: 2, input_observed: 3 };
    const input = stored && (!receipt.input || ranks[stored.phase] >= ranks[receipt.input.phase]) ? stored : receipt.input;
    const sessionId = input?.session_id ?? receipt.session_id;
    const started = fresh.operation === "start_session" && Boolean(sessionId)
      && (Boolean(input) || receipt.state === "succeeded");
    const accepted = fresh.operation !== "start_session" && input && input.phase !== "dispatched";
    // A raw terminal write remains uncertain, even if legacy pane heuristics returned ok.
    const completed = receipt.state === "succeeded" && (!input || input.phase !== "dispatched")
      && (fresh.operation !== "start_session" || Boolean(sessionId));
    const status = started || accepted || completed ? "succeeded"
      : receipt.state === "failed" ? "failed"
      : receipt.state === "running" ? "running" : "unknown";
    const result = receipt.result ?? {};
    const detail = status === "running" ? "已派发，正在等待原操作的输入证据"
      : status === "unknown" ? typeof result.error === "string" ? result.error.slice(0, 600)
        : "尚未取得原操作的输入证据；只查询原回执，不会自动重发"
      : typeof result.error === "string" && status === "failed" ? result.error.slice(0, 600) : null;
    const patch: Partial<SessionOperationRow> & { status?: SessionOperationStatus } = { status, detail,
      ...(input ? { input_receipt: JSON.stringify(input) } : {}),
      ...(fresh.operation === "start_session" && sessionId ? { session_id: sessionId } : {}),
      ...(fresh.operation !== "start_session" && sessionId ? { new_session_id: sessionId } : {}),
      finished_at: status === "running" ? null : fresh.finished_at ?? this.iso() };
    if (Object.entries(patch).every(([key, value]) => fresh[key as keyof SessionOperationRow] === value)) return this.viewOf(fresh);
    return this.write(fresh, patch);
  }

  private observeReceipt(row: SessionOperationRow): void {
    if (this.closed || !this.opts.caps || !row.runner_operation_id || !["running", "unknown"].includes(row.status)) return;
    const recovery = this.supervisor.submit({ id: `receipt:${row.id}`, reference: row.id, owner: row.owner,
      source: row.surface === "app:research-program" || row.surface === "app:research-v2" ? "research" : row.surface === "mcp:sessions" ? "mcp-session" : "session",
      desired: "running", observed: "running", resumeOwner: "runner", dispatch: "sent",
      operationId: row.runner_operation_id, sessionId: row.session_id, runtimeDevice: row.device });
    // A recovered connection wait must still publish its eventual clearance.
    if (["reconnecting", "waiting_resource"].includes(recovery.observed)) this.receiptWaits.add(recovery.id);
  }

  private receiptRecoveryChanged(job: ManagedExecutionRow): void {
    if (this.closed) return;
    const row = this.row(job.reference, job.owner);
    const wasWaiting = this.receiptWaits.delete(job.id);
    if (row && ["running", "unknown"].includes(row.status)) {
      const waiting = ["reconnecting", "waiting_resource"].includes(job.observed);
      if (waiting) this.receiptWaits.add(job.id);
      if (job.observed === "unknown" && job.detail && job.detail !== row.detail) this.write(row, { detail: job.detail });
      // Lease claims and next-observation scheduling do not change the public
      // operation. applyReceipt publishes actual evidence/status changes.
      else if (waiting || wasWaiting) this.emit(this.viewOf(row));
    }
  }

  close(): void {
    this.closed = true;
    for (const detach of this.detachSupervisors) detach();
    if (!this.opts.supervisor) this.supervisor.close();
    this.listeners.clear();
    this.receiptWaits.clear();
  }

  // ── approval ──

  /**
   * An approval was pressed for a call that belongs to a session operation.
   *
   * Returns null when the pending call is something else (a machine exec, a file
   * write) — the caller then handles it the way it always did. When it IS one of
   * ours, execution is started in the BACKGROUND and the record is what reports
   * the result: the approval endpoint used to hold its request open for the
   * whole CLI run, which is the same mistake the composer just stopped making.
   */
  approveAsOperation(pendingCallId: string, approver: string): SessionOperationView | null {
    const row = this.ownedByPending(pendingCallId, approver);
    if (!row) return null;
    if (!this.opts.caps) {
      return this.write(row, {
        status: "failed",
        detail: "capability service 未启用",
        finished_at: this.iso(),
      });
    }
    const executor = this.opts.executors[row.surface as OperationSurface];
    if (!executor) {
      // Do not claim the kernel card if its resource adapter is unavailable.
      // Keeping the row/card waiting is recoverable after the host is fixed;
      // marking it failed while the live card remains would create two truths.
      return this.write(row, {
        detail: `operation surface ${row.surface} 暂未装配；尚未执行`,
      });
    }
    const view = this.write(row, { status: "running", started_at: this.iso() });
    const caps = this.opts.caps;
    void (async () => {
      try {
        const out = await caps.approve(pendingCallId, approver);
        const fresh = this.row(row.id, row.owner);
        if (!fresh) return;
        if (out.status === "succeeded") {
          this.finish(fresh.id, fresh.owner, executor.interpret(out.result, intentOf(fresh)));
        } else if (out.status === "approval_required") {
          this.write(fresh, { status: "waiting_approval" });
        } else {
          this.write(fresh, {
            status: out.status === "unknown" ? "unknown" : "failed",
            detail: out.reason.slice(0, 600),
            finished_at: this.iso(),
          });
        }
      } catch (err) {
        const fresh = this.row(row.id, row.owner);
        if (fresh) {
          this.write(fresh, {
            status: "failed",
            detail: err instanceof Error ? err.message : String(err),
            finished_at: this.iso(),
          });
        }
      } finally {
        executor.releasePending(pendingCallId);
      }
    })().catch((err: unknown) =>
      log.error({ err, pendingCallId }, "approved session operation bookkeeping failed"),
    );
    return view;
  }

  /**
   * A rejection is a decision about the operation, not only about the card.
   *
   * Called AFTER the kernel has rejected, so unlike `approveAsOperation` it does
   * not ask whether the card is still live — the caller just watched it stop
   * being live, and asking again would answer "no" every time.
   */
  rejectAsOperation(pendingCallId: string, approver: string): SessionOperationView | null {
    const found = this.opts.store.getSessionOperationByPending(pendingCallId);
    const row = found && found.owner === approver && LIVE.has(found.status) ? found : null;
    if (!row) return null;
    const view = this.write(row, {
      status: "rejected",
      detail: "你拒绝了这条指令,设备上什么也没有发生。",
      finished_at: this.iso(),
    });
    this.opts.executors[row.surface as OperationSurface]?.releasePending(pendingCallId);
    return view;
  }

  /**
   * One browser login ended. Its undecided approval cards died with its
   * Context, so a record still claiming to be waiting for one is claiming
   * something that can no longer happen.
   *
   * Deliberately narrow: a submission already AT the device is left alone. The
   * frame is gone and pretending otherwise would be the same lie in the other
   * direction.
   */
  endCredential(owner: string, credential: string): number {
    let n = 0;
    // Every live record, not a recent window: an older waiting card must not
    // outlive its login just because 200 newer records exist.
    for (const row of this.opts.store.listLiveSessionOperations()) {
      if (row.owner !== owner || row.credential !== credential || row.status !== "waiting_approval") continue;
      if (row.pending_call_id) {
        this.opts.executors[row.surface as OperationSurface]?.releasePending(row.pending_call_id);
      }
      this.write(row, {
        status: "failed",
        detail: "发起这条指令的登录已结束,待批准的调用随之作废 — 设备上没有执行任何东西。",
        finished_at: this.iso(),
      });
      n++;
    }
    return n;
  }

  /**
   * End undecided calls rooted in one App instance without touching another
   * tab (or the direct Hub surface) owned by the same browser credential.
   * Context ids are trusted server-side lifecycle handles, never request data.
   */
  endContexts(owner: string, contextIds: readonly string[], reason = "应用实例已结束"): number {
    const wanted = new Set(contextIds.filter(Boolean));
    if (wanted.size === 0) return 0;
    let n = 0;
    for (const row of this.opts.store.listLiveSessionOperations()) {
      if (row.owner !== owner || row.status !== "waiting_approval" || !wanted.has(row.context_id ?? "")) continue;
      if (row.pending_call_id) {
        this.opts.executors[row.surface as OperationSurface]?.releasePending(row.pending_call_id);
      }
      this.write(row, {
        status: "failed",
        detail: `${reason}，尚未批准的调用已作废；设备上没有执行任何东西。`,
        finished_at: this.iso(),
      });
      n++;
    }
    return n;
  }

  // ── reads ──

  get(owner: string, id: string): SessionOperationView | null {
    const row = this.opts.store.getSessionOperation(id, owner);
    if (row) this.observeReceipt(row);
    return row ? this.viewOf(this.reconcileRow(row)) : null;
  }

  list(
    owner: string,
    o: { sessionId?: string; surface?: OperationSurface; limit?: number; beforeId?: string } = {},
  ): SessionOperationView[] {
    return this.opts.store
      .listSessionOperations(owner, o)
      .map((row) => { this.observeReceipt(row); return this.viewOf(this.reconcileRow(row)); });
  }

  // ── events ──

  subscribe(owner: string, fn: Listener, surface?: OperationSurface): () => void {
    const wrapped: Listener = surface ? (view) => { if (view.surface === surface) fn(view); } : fn;
    const set = this.listeners.get(owner) ?? new Set<Listener>();
    set.add(wrapped);
    this.listeners.set(owner, set);
    return () => {
      set.delete(wrapped);
      if (set.size === 0) this.listeners.delete(owner);
    };
  }

  // ── internals ──

  private iso(): string {
    return new Date(this.nowMs()).toISOString();
  }

  /**
   * Re-read a row before writing to it. Owner-scoped like every other read here:
   * the store has no lookup that answers without one, so an id on its own is
   * never enough to reach a record.
   */
  private row(id: string, owner: string): SessionOperationRow | undefined {
    return this.opts.store.getSessionOperation(id, owner);
  }

  /**
   * Only rows this approver actually owns, whose card the KERNEL still has.
   *
   * The second half matters: a card can be gone (rejected, expired, or killed
   * with the Context a revocation tore down) while the row still says
   * `waiting_approval`. Claiming it would report a submission as "running" when
   * the approval it needs no longer exists — and would hide the kernel's own
   * refusal behind a 202. Falling through instead lets the ordinary path answer
   * with what actually happened.
   */
  private ownedByPending(pendingCallId: string, approver: string): SessionOperationRow | null {
    const row = this.opts.store.getSessionOperationByPending(pendingCallId);
    if (!row || row.owner !== approver || !LIVE.has(row.status)) return null;
    // `state === "pending"` and not merely "the kernel knows this id": a
    // rejected or already-executed card is still readable, and treating one as
    // claimable would report a submission as running on the strength of a
    // decision that has already been made.
    return this.opts.caps?.getPending(pendingCallId, approver)?.state === "pending" ? row : null;
  }

  private write(
    row: SessionOperationRow,
    patch: Partial<SessionOperationRow> & { status?: SessionOperationStatus },
  ): SessionOperationView {
    const next: SessionOperationRow = { ...row, ...patch, updated_at: this.iso() };
    this.opts.store.updateSessionOperation(row.id, {
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.input_receipt !== undefined ? { input_receipt: patch.input_receipt } : {}),
      ...(patch.detail !== undefined ? { detail: patch.detail } : {}),
      ...(patch.pending_call_id !== undefined ? { pending_call_id: patch.pending_call_id } : {}),
      ...(patch.context_id !== undefined ? { context_id: patch.context_id } : {}),
      ...(patch.session_id !== undefined ? { session_id: patch.session_id } : {}),
      ...(patch.new_session_id !== undefined ? { new_session_id: patch.new_session_id } : {}),
      ...(patch.started_at !== undefined ? { started_at: patch.started_at } : {}),
      ...(patch.finished_at !== undefined ? { finished_at: patch.finished_at } : {}),
      updated_at: next.updated_at,
    });
    const view = this.viewOf(next);
    if (patch.status !== undefined && patch.status !== row.status) {
      const outcome: ConvergenceOutcome =
        patch.status === "succeeded" ? "ok"
          : patch.status === "unknown" ? "unknown"
            : patch.status === "failed" ? "failed"
              : patch.status === "rejected" || patch.status === "waiting_approval" ? "refused"
                : "observed";
      recordConvergenceUsage({
        candidate: "runner-device",
        principal: row.owner,
        endpoint: row.device,
        entry: `session-operation.${row.surface}.${row.operation}`,
        provider: "runner",
        release: row.cli_kind,
        effect: "execute",
        outcome,
        reason: patch.status,
      });
    }
    this.emit(view);
    return view;
  }

  private emit(view: SessionOperationView): void {
    for (const fn of this.listeners.get(view.owner) ?? []) {
      try {
        fn(view);
      } catch (err) {
        log.warn({ err }, "session operation listener threw");
      }
    }
  }

  /**
   * Bring a `waiting_approval` row back in line with the kernel, which is the
   * authority on whether a card is still undecided.
   *
   * Necessary because a card can be decided somewhere this coordinator never
   * sees: a Feishu button, an expiry sweep, or a decision taken while this
   * process was not running.
   */
  private reconcileRow(row: SessionOperationRow): SessionOperationRow {
    const status = this.reconcile(row);
    return status === row.status ? row : (this.opts.store.getSessionOperation(row.id, row.owner) ?? row);
  }

  private reconcile(row: SessionOperationRow): string {
    if (row.status !== "waiting_approval" || !row.pending_call_id) return row.status;
    const svc = this.opts.caps?.service;
    if (!svc) return row.status;
    const state = svc.pendingState(row.pending_call_id);
    const executor = this.opts.executors[row.surface as OperationSurface];
    if (state === "pending" || state === "claimed") return row.status;
    if (state === "rejected") {
      executor?.releasePending(row.pending_call_id);
      this.write(row, {
        status: "rejected",
        detail: "这条指令已被拒绝,设备上什么也没有发生。",
        finished_at: this.iso(),
      });
      return "rejected";
    }
    if (state === "expired") {
      executor?.releasePending(row.pending_call_id);
      this.write(row, {
        status: "failed",
        detail: "待批准超时,已作废 — 设备上什么也没有发生。重新提交会建立一条新的指令。",
        finished_at: this.iso(),
      });
      return "failed";
    }
    // finished, or the record is gone entirely. The kernel only answers
    // `resultOf` for the Context that made the call, which is why the Context id
    // is on the row: without it there is no honest answer but "unknown".
    const result = row.context_id ? svc.resultOf(row.context_id, row.pending_call_id) : null;
    try {
      if (result?.outcome === "succeeded" && executor) {
        this.finish(row.id, row.owner, executor.interpret(result.result, intentOf(row)));
      } else if (result?.outcome === "failed") {
        this.finish(row.id, row.owner, {
          ok: false,
          status: 502,
          error: (result.reason ?? "执行失败").slice(0, 600),
        });
      } else {
        this.finish(row.id, row.owner, {
          ok: false,
          status: 504,
          indeterminate: true,
          error: executor
            ? "这条指令的批准已经不在待批准队列里,而这个进程没有它的执行结果 —"
              + "无法证明它是否跑过,所以不会自动重发。请查看会话正文确认。"
            : `operation surface ${row.surface} 未装配，无法解释已完成的结果`,
        });
      }
    } finally {
      // A non-pending kernel state cannot continue holding the cross-surface
      // single-writer lease, regardless of which route made the decision.
      executor?.releasePending(row.pending_call_id);
    }
    return this.row(row.id, row.owner)?.status ?? "unknown";
  }

  private viewOf(row: SessionOperationRow): SessionOperationView {
    const status = (SESSION_OPERATION_STATUSES as readonly string[]).includes(row.status)
      ? (row.status as SessionOperationStatus)
      : "unknown";
    const input = inputForView(storedInputOf(row));
    const recovery = this.opts.store.managedExecutions.get(row.owner, `receipt:${row.id}`);
    const waiting = recovery && ["reconnecting", "waiting_resource"].includes(recovery.observed)
      && ["running", "unknown"].includes(status) ? recovery : undefined;
    return {
      id: row.id,
      owner: row.owner,
      surface: row.surface as OperationSurface,
      resourceId: row.resource_id,
      device: row.device,
      cliKind: row.cli_kind,
      sessionId: row.session_id,
      operation: row.operation,
      status,
      ...(input ? { input } : {}),
      ...(row.pending_call_id ? { pendingCallId: row.pending_call_id } : {}),
      ...(row.detail ? { detail: row.detail } : {}),
      ...(row.new_session_id ? { newSessionId: row.new_session_id } : {}),
      submittedAt: row.submitted_at,
      ...(row.started_at ? { startedAt: row.started_at } : {}),
      ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
      updatedAt: row.updated_at,
      live: LIVE.has(status) || Boolean(waiting),
      ...(waiting ? { recovery: { state: waiting.observed as "reconnecting" | "waiting_resource",
        since: waiting.unavailableSince!, resource: waiting.dependency!, retry_at: waiting.nextRetryAt ?? null } } : {}),
      message: waiting ? waiting.observed === "reconnecting"
        ? "设备暂时断开，正在重新连接并查询原输入回执…"
        : "等待设备恢复；恢复后会自动查询原输入回执，不会重复发送"
        : status === "succeeded" && row.operation !== "start_session" && input
        ? input.phase === "local_queued" ? "输入已进入 Agent 本地队列" : "Agent 已接收输入"
        : messageFor(status, row),
    };
  }
}

/**
 * The one sentence a chip renders. Server-side, because "what does `unknown`
 * mean" is a statement about what the system can and cannot prove, and a page
 * that composed it from a status string would eventually make a claim nobody
 * checked.
 */
export function messageFor(
  status: SessionOperationStatus,
  row: { operation: string; cli_kind: string; detail?: string | null } & Pick<SessionOperationRow, "input_receipt">,
): string {
  const verb = row.operation === "start_session" ? "启动" : row.operation === "resume_session" ? "恢复" : "续跑";
  const cli = row.cli_kind === "codex" || row.cli_kind === "omp" ? row.cli_kind : "claude";
  const reason = row.detail?.trim();
  switch (status) {
    case "submitted":
      return `已提交,正在派发到设备…`;
    case "waiting_approval":
      return `等待你批准 — 批准之前设备上什么也不会发生`;
    case "running":
      return row.operation === "start_session" ? `${cli} 正在启动新会话` : `${cli} 正在等待本机 CLI 响应`;
    case "succeeded":
      return row.operation === "start_session" ? "新会话已启动" : `${verb}完成,会话已更新`;
    case "failed":
      // The reason (for a Runner refusal, why nothing was sent) is what the
      // person needs before deciding to send again.
      return reason ? `${verb}失败：${reason}` : `${verb}失败`;
    case "rejected":
      return `已拒绝,设备上什么也没有发生`;
    case "unknown":
      // Only a write into a local CLI pane leaves a terminal to check and the
      // explicit takeover action; managed turns are checked in the transcript.
      return storedInputOf(row)?.evidence === "terminal_write"
        ? `结果无法确认 — 不会自动重发；请到本机 CLI 核对，确认未执行后可选择“交给 Octopus 托管”`
        : `结果无法确认 — 不会自动重发；请查看会话记录核对，确认未执行后可重新${row.operation === "start_session" ? "发起" : "发送"}`;
  }
}

/** A short, bounded summary of a Runner result. Never the transcript. */
function summarise(result: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof result.agent === "string") parts.push(result.agent);
  if (typeof result.duration_ms === "number") parts.push(`${Math.round(result.duration_ms / 1000)}s`);
  if (result.exit_code != null) parts.push(`exit ${String(result.exit_code)}`);
  const text = typeof result.result_text === "string" ? result.result_text.trim() : "";
  const head = parts.join(" · ");
  if (!text) return head;
  return `${head}${head ? " · " : ""}${text.slice(0, 400)}`;
}

function sameIntent(left: OperationIntent, right: OperationTicket): boolean {
  return left.owner === right.owner
    && left.resourceId === right.resourceId
    && left.device === right.device
    && left.cliKind === right.cliKind
    && left.sessionId === right.sessionId
    && left.operation === right.operation
    && left.fingerprint === right.fingerprint;
}

function intentOf(row: SessionOperationRow): OperationIntent {
  return {
    owner: row.owner,
    resourceId: row.resource_id,
    device: row.device,
    cliKind: row.cli_kind,
    sessionId: row.session_id,
    operation: row.operation,
    fingerprint: row.args_hash,
    ...(row.runner_operation_id ? { runnerOperationId: row.runner_operation_id } : {}),  };
}
