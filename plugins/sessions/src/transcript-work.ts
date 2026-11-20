/** Cooperative, bounded source work shared by all local readers. */
export class TranscriptWork {
  private foreground: Array<() => Promise<void>> = [];
  private background: Array<() => Promise<void>> = [];
  private running = false;
  private foregroundBurst = 0;

  run<T>(foreground: boolean, work: () => Promise<T>): Promise<T> {
    if (this.foreground.length + this.background.length >= 128) return Promise.reject(new Error("transcript work queue is full"));
    return new Promise<T>((resolve, reject) => {
      (foreground ? this.foreground : this.background).push(async () => {
        try { resolve(await work()); } catch (error) { reject(error); }
      });
      this.start();
    });
  }

  private start(): void {
    if (this.running) return;
    const useForeground = this.foreground.length > 0 && (this.foregroundBurst < 3 || !this.background.length);
    const next = (useForeground ? this.foreground : this.background).shift();
    if (!next) return;
    this.foregroundBurst = useForeground ? this.foregroundBurst + 1 : 0;
    this.running = true;
    // Each invocation is at most one source chunk. Even a continuous stream
    // leaves a turn for socket IO and reserves one in four turns for backfill.
    setImmediate(() => { void next().finally(() => { this.running = false; this.start(); }); });
  }
}
