/**
 * Wall-clock math for the nightly GitLab CI scan (`gitlab-ci.ts`).
 *
 * A pure function so it can be tested without the clock: Beijing (UTC+8)
 * 04:00 is exactly UTC 20:00 the previous day, so the scan is scheduled
 * against a UTC hour. There is no cron dependency. (Moved here from the
 * retired HQ scheduler, its original home, on 2026-10-15.)
 */

/**
 * Milliseconds from `now` to the next moment where Beijing wall-clock is
 * `hourBeijing:00`. Independent of the host's local timezone — the system
 * clock only has to be roughly right.
 */
export function msUntilNextBeijingHour(now: Date, hourBeijing: number): number {
  // Beijing = UTC+8, so Beijing hour H = UTC hour (H - 8 + 24) % 24.
  const utcHour = ((hourBeijing - 8) % 24 + 24) % 24;
  const nowMs = now.getTime();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  let target = Date.UTC(y, m, d, utcHour, 0, 0);
  if (target <= nowMs) target = Date.UTC(y, m, d + 1, utcHour, 0, 0);
  return target - nowMs;
}
