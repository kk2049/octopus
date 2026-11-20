import { dependencyWait } from "@claude-bot/runner/managed-execution";
import type { ResourceRecoveryService } from "./recovery.js";

export interface ResourceSuspensionView {
  state: "reconnecting" | "waiting_resource";
  resource: string;
  since: string;
  retry_at: string | null;
}

/** Durable intent lives in ResourceRecoveryService; timers only pace attempts.
 * A presence event wakes the original owner of the intent, never dispatches it.
 * That owner must recheck authority and its dispatch barrier before proceeding.
 */
export class ResourceSuspension {
  private readonly retries = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly unsubscribe: () => void;
  private closed = false;
  private recoveryVersion = 0;

  constructor(private readonly options: {
    recovery: ResourceRecoveryService;
    prefix: string;
    wake(scope: string): void;
    graceMs?: number;
    retryMs?: number;
    waitingRetryMs?: number;
    now?: () => number;
  }) {
    this.unsubscribe = options.recovery.registerScope(options.prefix, (waiter) => {
      if (this.closed) return false;
      this.recoveryVersion++;
      this.retries.delete(waiter.scope);
      options.wake(waiter.scope);
      this.arm();
      // Presence alone is not a successful, authorized resume. Keep the
      // durable wait until the caller proves its dependency usable.
      return false;
    });
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }

  view(scope: string): ResourceSuspensionView | null {
    const wait = this.options.recovery.pending(scope)[0];
    if (!wait) return null;
    const retry = this.retries.get(scope);
    return {
      state: dependencyWait(Date.parse(wait.first_seen_at), this.now(), this.options).state,
      resource: wait.resource,
      since: wait.first_seen_at,
      retry_at: retry === undefined ? null : new Date(retry).toISOString(),
    };
  }

  canAttempt(scope: string): boolean {
    return !this.closed && (this.retries.get(scope) ?? 0) <= this.now();
  }

  /** Capture before an async probe so a racing online event cannot be lost. */
  attemptVersion(): number { return this.recoveryVersion; }

  suspend(scope: string, resource: string, detail: string, attemptVersion = this.recoveryVersion): void {
    if (this.closed) return;
    if (!scope.startsWith(this.options.prefix)) throw new Error("resource suspension scope mismatch");
    if (!this.options.recovery.pending(scope).some((wait) => wait.resource === resource)) {
      // Persist immediately so a restart during the grace minute cannot lose
      // the user's intent. The visible waiting state starts after that minute.
      this.options.recovery.note(scope, resource, detail);
    }
    const view = this.view(scope)!;
    const delay = attemptVersion !== this.recoveryVersion ? 1
      : dependencyWait(Date.parse(view.since), this.now(), this.options).delayMs;
    this.retries.set(scope, this.now() + Math.max(1, delay));
    this.arm();
  }

  clear(scope: string): void {
    this.options.recovery.forget(scope);
    this.retries.delete(scope);
    this.arm();
  }

  close(): void {
    this.closed = true;
    this.unsubscribe();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.retries.clear();
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.closed || !this.retries.size) return;
    const deadline = Math.min(...this.retries.values());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const ready = [...this.retries].filter(([, at]) => at <= this.now());
      for (const [scope] of ready) this.retries.delete(scope);
      for (const [scope] of ready) this.options.wake(scope);
      this.arm();
    }, Math.max(1, deadline - this.now()));
    this.timer.unref?.();
  }
}
