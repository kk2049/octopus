/** Serial, last-request-wins reconciliation for Dashboard-owned Agent injection policy. */

export class AgentIntegrationPolicyReconciler {
  private desired: boolean;
  private applied: boolean | undefined;
  private running: Promise<void> | null = null;
  private closed = false;

  constructor(
    private readonly apply: (enabled: boolean) => Promise<void>,
    initialApplied?: boolean,
  ) {
    this.desired = initialApplied ?? false;
    this.applied = initialApplied;
  }

  setDefaultInjection(enabled: boolean): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.desired = enabled;
    return this.running ?? this.startDrain();
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.running?.catch(() => undefined);
  }

  private startDrain(): Promise<void> {
    const operation = this.drain();
    this.running = operation.finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async drain(): Promise<void> {
    while (!this.closed && this.applied !== this.desired) {
      const target = this.desired;
      await this.apply(target);
      this.applied = target;
    }
  }
}
