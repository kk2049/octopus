/**
 * A counting semaphore for work that shares one machine.
 *
 * Three tickets syncing their CI workspaces at once meant three `pnpm
 * install` + three workspace builds on the 48-core CI box at the same
 * moment (2026-08-22, 05:00–05:15 UTC): load 48, the Runner's event loop
 * silent for a minute, sshd's key exchange stalled past LoginGraceTime.
 * The box is shared; the pipeline is the only party that can pace itself.
 */
export class SlotGate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(readonly slots: number) {
    if (!Number.isInteger(slots) || slots < 1) throw new Error("SlotGate needs at least one slot");
  }

  /** How many callers hold a slot right now. */
  get inUse(): number {
    return this.active;
  }

  /** How many callers are queued behind the slots. */
  get queued(): number {
    return this.waiting.length;
  }

  /** Run `fn` once a slot is free; the slot is released however `fn` ends. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.slots) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiting.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  private release(): void {
    this.active--;
    const next = this.waiting.shift();
    if (next) next();
  }
}
