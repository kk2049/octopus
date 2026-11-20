import { GitLabMainline, MainlineError, type IntegrationLease } from "./gitlab-mainline.js";

/** Renewal is ordinary I/O, never an agent wake. Every caller has a finite
 * integration deadline. Loss stops publication, without killing the agent.
 */
export class IntegrationLeaseKeeper {
  private timer: NodeJS.Timeout | null;
  private pending: Promise<void> = Promise.resolve();
  private failure: unknown;
  private closed = false;
  constructor(readonly mainline: GitLabMainline, public lease: IntegrationLease,
    readonly deadline = Date.now() + 60 * 60_000) {
    this.timer = setInterval(() => { void this.renew(); }, Math.max(500, Math.floor(mainline.leaseMs / 3)));
    this.timer.unref();
  }
  async renew(): Promise<void> {
    this.pending = this.pending.then(async () => {
      if (this.closed || this.failure) return;
      try {
        if (Date.now() >= this.deadline) throw new MainlineError("lost_lease", "integration deadline reached; release and queue again");
        try { this.lease = await this.mainline.renew(this.lease); }
        catch (error) {
          // A definite CAS refusal can be retried after rereading. An unknown
          // side effect cannot; it must be reconciled before another command.
          if (!(error instanceof MainlineError) || error.code !== "busy") throw error;
          this.lease = await this.mainline.renew(this.lease);
        }
      } catch (error) { this.failure = error; this.clearTimer(); }
    });
    return this.pending;
  }
  private clearTimer(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
  /** Transfer renewal back to an existing local heartbeat after a repairable gate failure. */
  detach(): void { this.clearTimer(); this.closed = true; }
  async publish(candidate: string): Promise<string> {
    this.clearTimer(); await this.pending;
    if (this.closed) throw new MainlineError("lost_lease", "integration was already closed");
    if (this.failure) throw this.failure;
    if (Date.now() >= this.deadline) throw new MainlineError("lost_lease", "integration deadline reached");
    const sha = await this.mainline.publish(this.lease, candidate); this.closed = true; return sha;
  }
  async close(): Promise<void> {
    this.clearTimer(); await this.pending;
    if (this.closed) return;
    this.closed = true; await this.mainline.release(this.lease);
  }
}
