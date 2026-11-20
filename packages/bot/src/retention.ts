import { createLogger } from "./logger.js";

const log = createLogger("retention");

/** How long the append-only audit trails keep a row (capabilities.db and bot.db). */
export const AUDIT_RETENTION_MS = 30 * 24 * 3600_000;

/**
 * Repeat a small synchronous clean-up step, yielding the event loop between
 * steps.
 *
 * better-sqlite3 blocks the whole process for as long as a statement runs, so
 * a large backlog is worked off one bounded page at a time: `step` returns true
 * while more is immediately available, and the next step waits at least ten
 * times as long as the last one took. That keeps clean-up to about a tenth of
 * the event loop however slow the disk is. When a pass has nothing left, the
 * next one starts after `idleMs`. A throwing step is logged and retried after
 * `idleMs`; it never stops the loop.
 */
export function paceRetention(
  name: string,
  step: () => boolean,
  opts: { firstDelayMs?: number; pauseMs?: number; idleMs?: number; now?: () => number } = {},
): () => void {
  const pauseMs = opts.pauseMs ?? 250;
  const idleMs = opts.idleMs ?? 3600_000;
  const now = opts.now ?? (() => performance.now());
  let stopped = false;
  let steps = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (ms: number): void => {
    if (stopped) return;
    timer = setTimeout(tick, ms);
    timer.unref?.();
  };
  const tick = (): void => {
    const started = now();
    let more = false;
    try {
      more = step();
    } catch (err) {
      log.warn({ err, name }, "retention step failed; retrying after the idle interval");
    }
    steps++;
    if (!more) {
      if (steps > 1) log.info({ name, steps }, "retention pass finished");
      steps = 0;
    }
    schedule(more ? Math.max(pauseMs, 10 * (now() - started)) : idleMs);
  };
  schedule(opts.firstDelayMs ?? 5 * 60_000);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
