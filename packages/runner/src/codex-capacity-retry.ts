import type { CodexAppServerTurnResult, CodexManagedDispatch } from "./codex-app-server.js";

export const CODEX_CAPACITY_DELAYS_MS = [30_000, 60_000, 120_000, 300_000, 300_000, 300_000] as const;
export const CODEX_CAPACITY_WINDOW_MS = 30 * 60_000;

/** Device-private, prompt-free checkpoint. Attempts are charged BEFORE dispatch. */
export interface CodexCapacityCheckpoint {
  attempts: number;
  firstFailureAt: string;
  deadlineAt: string;
  phase: "waiting" | "dispatching" | "active";
  nextRetryAt?: string;
  /** Exact original receipt correlation, unchanged by restart continuations. */
  operationTurnId?: string;
}

export function isCodexCapacityFailure(result: CodexAppServerTurnResult): boolean {
  if (result.ok || result.status !== "failed" || result.providerError?.willRetry === true) return false;
  const code = result.providerError?.code;
  if (code) return code === "serverOverloaded";
  // Compatibility for older native servers only; no fuzzy "capacity" matching.
  return (result.providerError?.message || result.error)?.trim()
    === "Selected model is at capacity. Please try a different model.";
}

export function parseCapacityCheckpoint(value: unknown): CodexCapacityCheckpoint | undefined {
  if (value === undefined) return undefined;
  const row = value as CodexCapacityCheckpoint | null;
  if (!row || !Number.isInteger(row.attempts) || row.attempts < 0 || row.attempts > CODEX_CAPACITY_DELAYS_MS.length
    || !["waiting", "dispatching", "active"].includes(row.phase)
    || !validTime(row.firstFailureAt) || !validTime(row.deadlineAt)
    || Date.parse(row.deadlineAt) - Date.parse(row.firstFailureAt) !== CODEX_CAPACITY_WINDOW_MS
    || (row.phase === "waiting" && !validTime(row.nextRetryAt))
    || (row.nextRetryAt !== undefined && !validTime(row.nextRetryAt))) {
    throw new Error("invalid Codex capacity checkpoint");
  }
  return { attempts: row.attempts, firstFailureAt: row.firstFailureAt, deadlineAt: row.deadlineAt,
    phase: row.phase, ...(row.nextRetryAt ? { nextRetryAt: row.nextRetryAt } : {}),
    ...(typeof row.operationTurnId === "string" && row.operationTurnId.length <= 256
      ? { operationTurnId: row.operationTurnId } : {}) };
}

function validTime(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
}

/**
 * One logical Runner operation can contain several explicitly failed native
 * turns. The owner, not a hook or UI, keeps its completion pending throughout.
 * No original prompt, new model/account, transport fallback or second writer.
 */
export class CodexCapacityRetry {
  private checkpoint?: CodexCapacityCheckpoint;
  private cancelled = false;
  private wake?: () => void;
  private pending = false;
  private suspended = false;

  constructor(private readonly options: {
    dispatch: () => Promise<CodexManagedDispatch>;
    persist: (checkpoint: CodexCapacityCheckpoint) => Promise<boolean>;
    changed: () => void;
    restored?: CodexCapacityCheckpoint;
    now?: () => number;
  }) {
    this.checkpoint = options.restored;
  }

  get waiting(): boolean { return this.pending && !this.cancelled; }
  get state(): CodexCapacityCheckpoint | undefined { return this.checkpoint && { ...this.checkpoint }; }

  cancel(): void {
    this.cancelled = true;
    this.wake?.();
  }

  /** Planned resident shutdown is not the logical operation's final failure. */
  suspend(): void {
    this.suspended = Boolean(this.checkpoint);
    this.cancel();
  }

  run(initial: Promise<CodexAppServerTurnResult>): Promise<CodexAppServerTurnResult> {
    return this.observe(initial).then(result => this.suspended
      ? new Promise<CodexAppServerTurnResult>(() => {}) : result);
  }

  private async observe(initial: Promise<CodexAppServerTurnResult>): Promise<CodexAppServerTurnResult> {
    let result = await initial;
    while (!this.cancelled && isCodexCapacityFailure(result)) {
      const now = this.options.now?.() ?? Date.now();
      const prior = this.checkpoint;
      const attempts = prior?.attempts ?? 0;
      const deadlineAt = prior?.deadlineAt ?? new Date(now + CODEX_CAPACITY_WINDOW_MS).toISOString();
      const delay = CODEX_CAPACITY_DELAYS_MS[attempts];
      if (delay === undefined || now + delay >= Date.parse(deadlineAt)) {
        return { ...result, error: `Codex 容量不足；自动续接已停止（已尝试 ${attempts}/6 次，最多 30 分钟）。请稍后手动继续。` };
      }
      this.pending = true;
      try {
        const waiting: CodexCapacityCheckpoint = { attempts,
          firstFailureAt: prior?.firstFailureAt ?? new Date(now).toISOString(),
          deadlineAt, phase: "waiting", nextRetryAt: new Date(now + delay).toISOString() };
        if (!await this.save(waiting)) break;
        await this.wait(Math.max(0, Date.parse(waiting.nextRetryAt!) - (this.options.now?.() ?? Date.now())));
        if (this.cancelled) break;
        if ((this.options.now?.() ?? Date.now()) >= Date.parse(deadlineAt)) {
          return { ...result, error: "Codex 容量不足；自动续接已超过 30 分钟期限，请手动继续。" };
        }
        // An uncertain turn/start must stay dispatching on disk, never replay.
        if (!await this.save({ ...waiting, phase: "dispatching", attempts: attempts + 1, nextRetryAt: undefined })) break;
        if (this.cancelled) break;
        const action = await this.options.dispatch();
        if (action.kind !== "started") throw new Error("容量续接未获得独立的原生轮次确认");
        let recorded = false;
        try {
          recorded = await this.save({ ...waiting, phase: "active", attempts: attempts + 1, nextRetryAt: undefined });
        } catch { /* Acknowledged input remains observed even if disk fails. */ }
        if (!recorded) {
          // Input is already owned by Codex; keep observing, but never retry it.
          this.cancelled = true;
        }
        this.pending = false;
        this.options.changed();
        result = await action.completion;
      } catch (error) {
        return { started: true, ok: false,
          error: `Codex 容量续接结果无法确认，已停止自动重发：${error instanceof Error ? error.message : String(error)}` };
      } finally {
        this.pending = false;
        this.options.changed();
      }
    }
    return this.cancelled && isCodexCapacityFailure(result)
      ? { ...result, status: "interrupted", error: "已取消 Codex 容量自动续接。" } : result;
  }

  private async save(checkpoint: CodexCapacityCheckpoint): Promise<boolean> {
    this.checkpoint = checkpoint;
    if (this.cancelled || !await this.options.persist(checkpoint)) {
      this.cancelled = true;
      return false;
    }
    this.options.changed();
    return true;
  }

  private wait(ms: number): Promise<void> {
    if (this.cancelled) return Promise.resolve();
    return new Promise(resolve => {
      const timer = setTimeout(done, ms);
      timer.unref?.();
      const self = this;
      function done(): void { clearTimeout(timer); self.wake = undefined; resolve(); }
      this.wake = done;
      if (this.cancelled) done();
    });
  }
}
