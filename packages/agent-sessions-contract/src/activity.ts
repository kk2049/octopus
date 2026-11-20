/**
 * When transcript activity still means "running". A finished headless run
 * writes nothing to say it finished, so the answer is a function of NOW: every
 * host (Agent View, Dashboard, Session Hub and dev tickets) must make the same
 * claim from the same evidence, and re-evaluate it rather than store it.
 */
import type { Activity } from "./projection.js";

/** An unpaired tool this quiet is probably a corpse, not a build. */
export const TOOL_STALE_MS = 600_000;
/** A model that owes us output and writes nothing this long has stopped. */
export const QUIET_MS = 90_000;

export function isBusy(activity: Activity | null | undefined): boolean {
  return Boolean(activity) && activity!.state !== "idle";
}

/** Milliseconds since the log last grew, or -1 when no timestamp is usable. */
export function silenceOf(activity: Activity | null | undefined, nowMs: number): number {
  if (!activity) return -1;
  const iso = activity.observed_at || activity.since;
  if (!iso) return -1;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return -1;
  return Math.max(0, nowMs - t);
}

export type ActivityPhase = "" | "live" | "stale";

/**
 * What to render RIGHT NOW: "" (idle or the turn ended), "live" (still working)
 * or "stale" (an unpaired tool gone quiet for too long). Callers must
 * re-evaluate on every tick; that is the whole point.
 */
export function activityPhase(activity: Activity | null | undefined, nowMs: number): ActivityPhase {
  if (!isBusy(activity)) return "";
  const quiet = silenceOf(activity, nowMs);
  if (quiet < 0) return "live"; // no timestamp: cannot prove it stopped
  if (activity!.state === "tool") return quiet > TOOL_STALE_MS ? "stale" : "live";
  return quiet > QUIET_MS ? "" : "live";
}

/**
 * Worth treating as alive. Busy is not enough: a session aborted mid-tool keeps
 * a pending tool call forever, and following it would pin an indicator to a
 * corpse.
 */
export function shouldFollow(activity: Activity | null | undefined, nowMs = Date.now()): boolean {
  return activityPhase(activity, nowMs) === "live";
}
