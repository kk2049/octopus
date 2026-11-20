/**
 * Fixture: the app's own second file. Reaching it requires the bundler to
 * resolve a relative import and inline it — the runtime release will only ever
 * materialise `actions.ts` and `projection.ts`.
 */

export const MAX_SEAT = 63;

/**
 * SES-censor bait, ON PURPOSE (regression for the chess.js incident): the
 * string carries " --> " and "<!--" and the loop spells `i-->0` — all of which
 * SES's TEXTUAL censor rejects at Compartment import unless the pack-time
 * evasive transform rewrites them. The e2e below dispatches this for real.
 */
export const ARROW_TEMPLATE = "line --> here <!-- note";

export function countDown(n: number): number {
  let i = n;
  let steps = 0;
  // prettier-ignore
  while (i-->0) steps += 1;
  return steps;
}

/** A decimal seat index inside `0..MAX_SEAT`. Anything else is a refusal, not a clamp. */
export function clampSeat(value: unknown): number {
  const seat = typeof value === "number" ? Math.floor(value) : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(seat) || seat < 0 || seat > MAX_SEAT) {
    throw new Error(`seat ${String(value)} is out of range`);
  }
  return seat;
}
