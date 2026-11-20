import { dependencyWait, recoveryAction, type ManagedExecutionSource, type RecoveryAction } from "@claude-bot/runner/managed-execution";
import type { ManagedExecutionRow, ManagedExecutionsRepository } from "../store/repositories/managed-executions.js";
import type { ResourceRecoveryService } from "../resources/recovery.js";
import { createLogger } from "../logger.js";

const log = createLogger("managed-execution");
const prefix = "managed-execution/";
export type ExecutionStep =
  | { kind: "completed" | "failed" | "unknown" | "waiting_approval"; detail?: string }
  | { kind: "wait"; dependency: string; detail: string }
  | { kind: "observe"; delayMs?: number };

export interface ExecutionLease {
  readonly row: ManagedExecutionRow;
  readonly signal: AbortSignal;
  /** Persist BEFORE a side effect; a stale/cancelled lease refuses the effect. */
  checkpoint(value: unknown, dispatch: ManagedExecutionRow["dispatch"]): void;
  assertCurrent(): void;
  /** A positive response ends the current outage, without ending the task. */
  dependencyAvailable(): void;
}
export interface ManagedExecutionAdapter {
  maxConcurrent?: number;
  dependencyPolicy?: Parameters<typeof dependencyWait>[2];
  /** Always re-read domain pause/cancel state and current grants. */
  authorized(row: ManagedExecutionRow): boolean | Promise<boolean>;
  reconcile(lease: ExecutionLease, action: RecoveryAction): Promise<ExecutionStep>;
  changed?(row: ManagedExecutionRow): void;
}

/** One scheduler for all Head-owned recovery adapters; no execute authority of its own. */
export class ManagedExecutionSupervisor {
  private readonly adapters = new Map<ManagedExecutionSource, ManagedExecutionAdapter>();
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly controllers = new Map<string, { source: ManagedExecutionSource; abort: AbortController }>();
  private readonly detach: () => void;
  private readonly pendingWake = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private nextSource = 0;

  constructor(private readonly store: ManagedExecutionsRepository, private readonly recovery: ResourceRecoveryService,
    private readonly now: () => number = Date.now) {
    this.detach = recovery.registerScope(prefix, waiter => {
      const id = waiter.scope.slice(prefix.length);
      if (this.inflight.has(id)) this.pendingWake.add(id);
      else this.wakeRecord(id);
      return false;
    });
  }

  register(source: ManagedExecutionSource, adapter: ManagedExecutionAdapter): () => void {
    if (this.adapters.has(source)) throw new Error(`managed execution adapter already registered: ${source}`);
    this.adapters.set(source, adapter);
    this.kick();
    return () => {
      if (this.adapters.get(source) !== adapter) return;
      this.adapters.delete(source);
      for (const value of this.controllers.values()) if (value.source === source) value.abort.abort();
    };
  }

  submit(input: Omit<ManagedExecutionRow, "revision" | "createdAt" | "updatedAt">): ManagedExecutionRow {
    const at = this.iso();
    const row = this.store.create({ ...input, createdAt: at, updatedAt: at });
    this.kick();
    return row;
  }

  get(owner: string, id: string): ManagedExecutionRow | undefined { return this.store.get(owner, id); }

  setDesired(owner: string, id: string, desired: ManagedExecutionRow["desired"]): boolean {
    const row = this.store.get(owner, id);
    if (!row) return false;
    const next = this.store.replace(row, { ...row, desired, updatedAt: this.iso() });
    if (!next) return false;
    if (desired !== "running") {
      this.controllers.get(id)?.abort.abort();
      this.recovery.forget(`${prefix}${id}`);
    }
    this.adapters.get(next.source)?.changed?.(next);
    this.kick();
    return true;
  }

  kick(): void {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.sweep(); }, 1);
    this.timer.unref?.();
  }

  async sweep(): Promise<void> {
    if (this.closed) return;
    const work: Promise<void>[] = [];
    const adapters = [...this.adapters];
    const start = this.nextSource++ % Math.max(1, adapters.length);
    for (let index = 0; index < adapters.length; index++) {
      const [source, adapter] = adapters[(start + index) % adapters.length]!;
      let active = [...this.controllers.values()].filter(value => value.source === source).length;
      // The configured per-source concurrency is the limit; no hidden ceiling.
      const limit = Math.max(1, adapter.maxConcurrent ?? 2);
      if (active >= limit) continue;
      // Private checkpoints can be large; read only enough for the available
      // slots, including this source's already-inflight rows at the front.
      for (const row of this.store.ready(source, this.iso(), limit)) {
        if (this.inflight.has(row.id)) continue;
        if (active >= limit) break;
        active++;
        const abort = new AbortController();
        this.controllers.set(row.id, { source, abort });
        const task = Promise.resolve().then(() => this.reconcile(row, adapter, abort.signal)).catch(error => {
          if (!(error instanceof ExecutionLeaseEnded)) log.error({ id: row.id, source, err: error }, "managed recovery bookkeeping failed");
        }).finally(() => {
          this.inflight.delete(row.id);
          this.controllers.delete(row.id);
          if (this.pendingWake.delete(row.id)) this.wakeRecord(row.id);
        });
        this.inflight.set(row.id, task);
        work.push(task);
      }
    }
    // Keep the scheduler alive while slow model requests occupy other lanes.
    if (!this.closed && !this.timer) {
      this.timer = setTimeout(() => { this.timer = undefined; void this.sweep(); }, 1000);
      this.timer.unref?.();
    }
    await Promise.allSettled(work);
  }

  close(): Promise<void> {
    this.closed = true;
    for (const value of this.controllers.values()) value.abort.abort();
    this.detach();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    return Promise.allSettled([...this.inflight.values()]).then(() => undefined);
  }

  private async reconcile(initial: ManagedExecutionRow, adapter: ManagedExecutionAdapter, signal: AbortSignal): Promise<void> {
    let row = initial;
    const assertCurrent = (): void => {
      if (this.closed || signal.aborted) throw new ExecutionLeaseEnded();
      const fresh = this.store.get(row.owner, row.id);
      if (this.closed || signal.aborted || !fresh || fresh.revision !== row.revision || fresh.desired !== "running") {
        throw new ExecutionLeaseEnded();
      }
    };
    const save = (patch: Partial<ManagedExecutionRow>): void => {
      assertCurrent();
      const next = this.store.replace(row, { ...row, ...patch, updatedAt: this.iso() });
      if (!next) throw new ExecutionLeaseEnded();
      row = next;
    };
    const lease: ExecutionLease = { get row() { return row; }, signal, assertCurrent,
      dependencyAvailable: () => {
        save({ observed: "running", dependency: undefined, unavailableSince: undefined,
          nextRetryAt: undefined, failure: undefined, detail: undefined });
        this.recovery.forget(`${prefix}${row.id}`);
      },
      checkpoint: (checkpoint, dispatch) => save({ checkpoint, dispatch, observed: "running" }),
    };
    let allowed: boolean;
    try { allowed = await adapter.authorized(row); }
    catch {
      // A broken authority lookup is not positive authority or transport proof.
      save({ observed: "unknown", failure: "internal", detail: "无法确认当前授权，自动恢复已停止", nextRetryAt: undefined });
      this.recovery.forget(`${prefix}${row.id}`);
      adapter.changed?.(row);
      return;
    }
    assertCurrent();
    const action = recoveryAction({ desired: row.desired, resumeOwner: row.resumeOwner, coordinator: "head",
      authorized: allowed, dependencyAvailable: true, dispatch: row.dispatch });
    if (action === "none") return;
    let result: ExecutionStep;
    if (action === "refuse") {
      result = { kind: "failed", detail: "授权已撤销，恢复已停止" };
    } else {
      // Adapter exceptions are never proof that dispatch did not happen.
      try { result = await adapter.reconcile(lease, action); }
      catch { result = { kind: "unknown", detail: "恢复执行中断，无法证明副作用结果；不会自动重发" }; }
    }
    assertCurrent();
    if (result.kind === "wait") {
      const since = row.dependency === result.dependency ? row.unavailableSince ?? this.iso() : this.iso();
      const wait = dependencyWait(Date.parse(since), this.now(), adapter.dependencyPolicy);
      save({ observed: wait.state, dependency: result.dependency, unavailableSince: since,
        nextRetryAt: new Date(this.now() + wait.delayMs).toISOString(), failure: "transport_unavailable", detail: result.detail });
      this.recovery.note(`${prefix}${row.id}`, result.dependency, result.detail);
    } else {
      this.recovery.forget(`${prefix}${row.id}`);
      save({ observed: result.kind === "observe" ? "running" : result.kind,
        nextRetryAt: result.kind === "observe" ? new Date(this.now() + (result.delayMs ?? 5000)).toISOString() : undefined,
        dependency: undefined, unavailableSince: undefined, failure: result.kind === "unknown" ? "effect_unknown" : action === "refuse" ? "authorization_revoked" : undefined,
        ...("detail" in result ? { detail: result.detail } : { detail: undefined }) });
    }
    adapter.changed?.(row);
    // Domain transcripts retain the result. Settled identity tombstones need
    // no duplicate prompt/tool history; unknown effects remain inspectable.
    if (["completed", "failed", "waiting_approval"].includes(row.observed) && row.checkpoint !== undefined) save({ checkpoint: undefined });
  }

  private wakeRecord(id: string): void {
    if (this.closed) return;
    const row = this.store.getForRecovery(id);
    if (!row || row.desired !== "running" || !this.adapters.has(row.source)
      || !["reconnecting", "waiting_resource"].includes(row.observed)) return;
    if (this.store.replace(row, { ...row, nextRetryAt: undefined, updatedAt: this.iso() })) this.kick();
  }

  private iso(): string { return new Date(this.now()).toISOString(); }
}

class ExecutionLeaseEnded extends Error {
  constructor() { super("managed execution lease ended"); }
}
